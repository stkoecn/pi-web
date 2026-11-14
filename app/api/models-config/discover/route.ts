import { NextResponse } from "next/server";
import { resolveModelDiscoveryAuth } from "@/lib/model-discovery-auth";
import { buildModelsListUrl, parseDiscoveredModels } from "@/lib/model-discovery";
import { getRequestDeviceId, isRemoteDevice } from "@/lib/device-context";
import { shellQuote } from "@/lib/shell-quote";

export const dynamic = "force-dynamic";

const DISCOVERY_TIMEOUT_MS = 20_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasHeader(headers: Headers, name: string): boolean {
  return headers.has(name);
}

function buildHeaders(api: string, apiKey: string | undefined, configured: Record<string, string>): Headers {
  const headers = new Headers(configured);
  if (!hasHeader(headers, "accept")) headers.set("Accept", "application/json");
  if (!apiKey) return headers;

  if (api === "anthropic-messages") {
    if (!hasHeader(headers, "x-api-key")) headers.set("x-api-key", apiKey);
    if (!hasHeader(headers, "anthropic-version")) headers.set("anthropic-version", "2023-06-01");
  } else if (api === "google-generative-ai") {
    if (!hasHeader(headers, "x-goog-api-key")) headers.set("x-goog-api-key", apiKey);
  } else if (!hasHeader(headers, "authorization")) {
    headers.set("Authorization", `Bearer ${apiKey}`);
  }
  return headers;
}

export async function POST(req: Request) {
  try {
    const body = await req.json() as { providerName?: unknown; provider?: unknown; deviceId?: unknown };
    const providerName = typeof body.providerName === "string" ? body.providerName.trim() : "";
    if (!providerName) return NextResponse.json({ error: "providerName is required" }, { status: 400 });
    if (!isRecord(body.provider)) return NextResponse.json({ error: "provider is required" }, { status: 400 });

    const configuredBaseUrl = typeof body.provider.baseUrl === "string" ? body.provider.baseUrl.trim() : "";
    const configuredApi = typeof body.provider.api === "string" && body.provider.api ? body.provider.api : "";

    let auth: Awaited<ReturnType<typeof resolveModelDiscoveryAuth>>;
    try {
      auth = await resolveModelDiscoveryAuth(providerName, body.provider);
    } catch (error) {
      // Without a configured Base URL, pi's catalog was the only other source of
      // one; for a custom provider it fails with an error about the placeholder model.
      if (!configuredBaseUrl) return NextResponse.json({ error: "Base URL is required" }, { status: 400 });
      throw error;
    }
    if (typeof body.provider.apiKey === "string" && body.provider.apiKey.trim() && !auth.apiKey) {
      return NextResponse.json({ error: `No API key found for "${providerName}"` }, { status: 400 });
    }

    // Fall back to pi's provider catalog so built-in providers, and entries
    // that only list models, do not have to repeat the upstream base URL.
    const baseUrl = configuredBaseUrl || auth.baseUrl || "";
    if (!baseUrl) return NextResponse.json({ error: "Base URL is required" }, { status: 400 });
    const api = configuredApi || auth.api || "openai-completions";

    let endpoint: URL;
    try {
      endpoint = buildModelsListUrl(baseUrl, api);
    } catch {
      return NextResponse.json({ error: "Base URL is invalid" }, { status: 400 });
    }

    // A provider's Base URL often names the DEVICE's own loopback (a proxy on
    // the machine pi runs on), which this server cannot reach: the discovery
    // fetch runs on the device over its SSH channel.
    const bodyDeviceId = typeof body.deviceId === "string" ? body.deviceId : undefined;
    const deviceId = bodyDeviceId ?? getRequestDeviceId(req);
    if (isRemoteDevice(deviceId)) {
      // discoverOnDevice already answers with its own NextResponse — wrapping
      // it again serialized the Response object into `{}`.
      return discoverOnDevice(deviceId, endpoint, api, auth.apiKey, auth.headers);
    }

    const response = await fetch(endpoint, {
      cache: "no-store",
      headers: buildHeaders(api, auth.apiKey, auth.headers),
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
    const responseText = await response.text();
    if (!response.ok) {
      return NextResponse.json({
        error: responseText.slice(0, 500) || `Upstream returned HTTP ${response.status}`,
        status: response.status,
      }, { status: 502 });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(responseText);
    } catch {
      return NextResponse.json({ error: "Upstream model list was not valid JSON" }, { status: 502 });
    }
    const models = parseDiscoveredModels(payload);
    if (models.length === 0) {
      return NextResponse.json({ error: "No models found in the upstream response" }, { status: 502 });
    }

    return NextResponse.json({ models, endpoint: endpoint.toString() });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = error instanceof DOMException && error.name === "TimeoutError" ? 504 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

/** Run the discovery fetch on the device itself, where its Base URL resolves. */
async function discoverOnDevice(
  deviceId: string,
  endpoint: URL,
  api: string,
  apiKey: string | undefined,
  configuredHeaders: Record<string, string>,
): Promise<NextResponse> {
  try {
    const { getGateway } = await import("@/lib/gateway/singleton");
    const driver = await getGateway().getOrConnectDriver(deviceId);

    const headers = buildHeaders(api, apiKey, configuredHeaders);
    // curl marks HTTP errors only in its status line (-sS hides progress but the
    // body still prints), so ask for the code and split it off the body.
    const parts = [
      "curl", "-sS", "-m", "15", "-X", "GET", shellQuote(endpoint.toString()),
      ...[...headers.entries()].map(([name, value]) => `-H ${shellQuote(`${name}: ${value}`)}`),
      "-w", shellQuote("\n__PIWEB_STATUS__%{http_code}"),
    ];
    const result = await driver.exec(parts.join(" "), [], { timeoutMs: DISCOVERY_TIMEOUT_MS + 10_000 });

    const separatorAt = result.stdout.lastIndexOf("__PIWEB_STATUS__");
    const bodyText = separatorAt >= 0 ? result.stdout.slice(0, separatorAt) : result.stdout;
    const httpStatus = separatorAt >= 0 ? Number(result.stdout.slice(separatorAt + "__PIWEB_STATUS__".length).trim()) : 0;

    if (httpStatus === 0) {
      // curl never reached an HTTP answer: its stderr names the cause
      // (connection refused, unknown host, timeout).
      const detail = (result.stderr || bodyText || "no output").trim().slice(0, 300);
      return NextResponse.json({ error: `The device could not reach ${endpoint.host}: ${detail}` }, { status: 502 });
    }
    if (httpStatus >= 400) {
      return NextResponse.json({
        error: bodyText.slice(0, 500) || `Upstream returned HTTP ${httpStatus}`,
        status: httpStatus,
      }, { status: 502 });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(bodyText);
    } catch {
      return NextResponse.json({ error: "Upstream model list was not valid JSON" }, { status: 502 });
    }
    const models = parseDiscoveredModels(payload);
    if (models.length === 0) {
      return NextResponse.json({ error: "No models found in the upstream response" }, { status: 502 });
    }
    const payloadOut = { models, endpoint: endpoint.toString() };
    return NextResponse.json(payloadOut);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const offline = /not connected or offline/i.test(message);
    return NextResponse.json({ error: message }, { status: offline ? 503 : 500 });
  }
}
