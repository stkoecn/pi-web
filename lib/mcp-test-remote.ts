import "server-only";
import { NextResponse } from "next/server";
import type { McpErrorResponse, McpScope, McpTestResponse, McpTestResult } from "@/lib/api-types";
import { getGateway } from "@/lib/gateway/singleton";
import { getRequestDeviceId, isRemoteDevice } from "@/lib/device-context";
import { mcpEntryConfigKey } from "@/lib/mcp-config-key";
import { MCP_TEST_DEVICE_SCRIPT } from "@/lib/mcp-test-device-script";
import {
  argSecretParts,
  commandSecretParts,
  SECRET_MASK,
  urlSecretParts,
} from "@/lib/mcp-secrets";
import { recordMcpStatus } from "@/lib/mcp-status";

/**
 * Settings › MCP's Test for a device: the probe runs on the machine the server
 * lives on (its command resolves there, its ports are its own), over the same
 * SSH channel every other device capability uses. The entry is read from the
 * DEVICE's own `mcp.json` — never a config from the browser — and what the
 * probe saw is masked against the entry's secrets before it reaches a browser.
 */

const PROBE_TIMEOUT_MS = 45_000;
const ERROR_MAX_CHARS = 2_000;
const STDERR_TAIL_CHARS = 2_000;
const REDACT_WINDOW_CHARS = 64 * 1024;
const TEXT_MAX_CHARS = 300;

interface RawProbeResult {
  state: "connected" | "needs-auth" | "failed";
  error?: unknown;
  stderr?: unknown;
  timedOut?: unknown;
  tools?: unknown;
  toolCount?: unknown;
  serverInfo?: unknown;
  durationMs?: unknown;
  testedAt?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Every string in the entry a server could echo back: the command, the args,
 * the URL, and the literal env and header values. Replacing each occurrence in
 * the probe's answer is coarser than the local test's word-aware redactor and
 * safe in the same direction — a value that looks like a secret is hidden even
 * where the local test would have shown it.
 */
function collectSecrets(config: Record<string, unknown>): string[] {
  const secrets = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (trimmed.length >= 6) secrets.add(trimmed);
  };
  add(config.command);
  for (const part of commandSecretParts(typeof config.command === "string" ? config.command : "")) secrets.add(part);
  const args = Array.isArray(config.args) ? config.args.map(String) : [];
  for (const arg of args) add(arg);
  for (const part of argSecretParts(args)) secrets.add(part);
  add(config.url);
  for (const part of urlSecretParts(typeof config.url === "string" ? config.url : "")) secrets.add(part);
  if (isRecord(config.env)) for (const value of Object.values(config.env)) add(value);
  if (isRecord(config.headers)) for (const value of Object.values(config.headers)) add(value);
  return [...secrets].filter((secret) => secret !== SECRET_MASK);
}

function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (out.includes(secret)) out = out.split(secret).join(SECRET_MASK);
  }
  return out;
}

function headOf(text: string, secrets: readonly string[], max: number): string {
  return clip(redact(text.slice(0, REDACT_WINDOW_CHARS), secrets), max);
}

function tailOf(text: string, secrets: readonly string[], max: number): string {
  return redact(text.slice(-REDACT_WINDOW_CHARS), secrets).slice(-max);
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}

/**
 * Test one MCP server of a device: read the entry from the device's own file,
 * run the probe there, and answer the same `McpTestResponse` the local route
 * produces. Refusals carry the same `reason` vocabulary the local entry reader
 * uses, so the panel cannot tell the transports apart.
 */
export async function testRemoteMcpServer(req: Request): Promise<NextResponse> {
  const deviceId = getRequestDeviceId(req);
  if (!isRemoteDevice(deviceId)) {
    return NextResponse.json({ error: "Not a remote device", reason: "invalid-request" }, { status: 400 });
  }
  let body: { scope?: unknown; name?: unknown; cwd?: unknown };
  try {
    body = await req.json() as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid request body", reason: "invalid-request" }, { status: 400 });
  }
  const scope: McpScope = body.scope === "project" ? "project" : "global";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return NextResponse.json({ error: "name is required", reason: "invalid-request" }, { status: 400 });
  const cwd = typeof body.cwd === "string" && body.cwd ? body.cwd : undefined;

  try {
    const { getRemoteAgentDir } = await import("@/lib/remote-settings");
    const { openRemoteMcp } = await import("@/lib/remote-mcp-actions");
    const { readRemoteMcpEntry, remoteGlobalMcpPath, remoteProjectMcpPath, remoteReferencesWebPassword } = await import(
      "@/lib/remote-mcp-write"
    );
    const { loadPiSdkInternals } = await import("@/lib/pi-sdk-internals");

    const internalsResult = await loadPiSdkInternals();
    if (!internalsResult.ok) {
      return NextResponse.json(
        { error: `Pi Web cannot load the SDK's MCP modules: ${internalsResult.reason}`, reason: "mcp-off" },
        { status: 409 },
      );
    }
    const internals = internalsResult;

    const gateway = getGateway();
    const driver = await gateway.getDriverForRequest(deviceId);
    const agentDir = await getRemoteAgentDir(deviceId);
    const context = await openRemoteMcp(deviceId, driver, agentDir, cwd ?? null, internals);

    const sourcePath = scope === "global" ? remoteGlobalMcpPath(agentDir) : remoteProjectMcpPath(cwd ?? "");
    const text = scope === "global" ? context.globalText : context.projectText;
    const read = readRemoteMcpEntry(text, sourcePath, scope, name, internals);
    if (!read.ok) {
      return NextResponse.json(
        {
          error: read.error ?? `${sourcePath} does not define MCP server "${name}"`,
          reason: read.reason,
          path: read.path,
          name,
        },
        { status: read.reason === "server-missing" ? 404 : 400 },
      );
    }
    if (remoteReferencesWebPassword(read.value, internals)) {
      return NextResponse.json(
        { error: "This entry references PI_WEB_PASSWORD, which a device cannot resolve", reason: "web-password" },
        { status: 400 },
      );
    }

    const entryValue = isRecord(read.value) ? read.value : {};
    const configKey = mcpEntryConfigKey(entryValue, read.config);
    const probe = await runDeviceProbe(deviceId, entryValue);
    const secrets = collectSecrets(entryValue);
    const result = shapeResult(probe, secrets);
    recordMcpStatus({ scope, sourcePath, name }, configKey, { origin: "test", ...result });
    return NextResponse.json({ scope, name, configKey, result } satisfies McpTestResponse);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const offline = /not connected or offline/i.test(message);
    // Offline is a state the client acts on, not a refusal reason the MCP
    // vocabulary has: it travels as a plain error with the status code.
    return NextResponse.json({ error: message }, { status: offline ? 503 : 500 });
  }
}

async function runDeviceProbe(deviceId: string, entry: Record<string, unknown>): Promise<RawProbeResult> {
  const { REMOTE_PATH_PREFIX } = await import("@/lib/gateway/drivers/persistent-shell");
  const gateway = getGateway();
  const driver = await gateway.getDriverForRequest(deviceId);
  const scriptB64 = Buffer.from(MCP_TEST_DEVICE_SCRIPT, "utf8").toString("base64");
  const entryB64 = Buffer.from(JSON.stringify(entry), "utf8").toString("base64");
  // The PATH prefix carries pi's own node runtime, so the probe does not depend
  // on the SSH session's shell defaults.
  const cmd = `${REMOTE_PATH_PREFIX} PIWEB_MCP_PROBE=${entryB64} node -e "eval(Buffer.from('${scriptB64}','base64').toString('utf8'))"`;
  const result = await driver.exec(cmd, [], { timeoutMs: PROBE_TIMEOUT_MS });
  const marker = result.stdout.indexOf("__PIWEB_RESULT__");
  if (marker < 0) {
    const detail = (result.stderr || result.stdout || "no output").trim().slice(0, 300);
    return {
      state: "failed",
      error: `The device's probe produced no result: ${detail}`,
      tools: [],
      toolCount: 0,
      testedAt: Date.now(),
    };
  }
  try {
    return JSON.parse(result.stdout.slice(marker + "__PIWEB_RESULT__".length)) as RawProbeResult;
  } catch {
    return { state: "failed", error: "The device's probe answer was not valid JSON", tools: [], toolCount: 0, testedAt: Date.now() };
  }
}

function shapeResult(probe: RawProbeResult, secrets: readonly string[]): McpTestResult {
  const rawTools = Array.isArray(probe.tools) ? probe.tools : [];
  const tools = rawTools.slice(0, 500).map((tool) => {
    const record = isRecord(tool) ? tool : {};
    return {
      name: headOf(String(record.name ?? ""), secrets, TEXT_MAX_CHARS),
      ...(typeof record.description === "string" && record.description
        ? { description: headOf(record.description, secrets, TEXT_MAX_CHARS) }
        : {}),
      readOnly: record.readOnly === true,
      exposure: "direct" as const,
    };
  });
  const state = probe.state === "connected" || probe.state === "needs-auth" ? probe.state : "failed";
  const info = isRecord(probe.serverInfo) ? probe.serverInfo : undefined;
  return {
    state,
    ...(typeof probe.error === "string" && probe.error ? { error: headOf(probe.error, secrets, ERROR_MAX_CHARS) } : {}),
    ...(typeof probe.stderr === "string" && probe.stderr ? { stderr: tailOf(probe.stderr, secrets, STDERR_TAIL_CHARS) } : {}),
    ...(probe.timedOut === true ? { timedOut: true } : {}),
    tools,
    toolCount: typeof probe.toolCount === "number" ? probe.toolCount : tools.length,
    ...(info && typeof info.name === "string"
      ? {
        serverInfo: {
          name: headOf(info.name, secrets, TEXT_MAX_CHARS),
          version: headOf(typeof info.version === "string" ? info.version : "", secrets, TEXT_MAX_CHARS),
          ...(typeof info.title === "string" ? { title: headOf(info.title, secrets, TEXT_MAX_CHARS) } : {}),
        },
      }
      : {}),
    durationMs: typeof probe.durationMs === "number" ? probe.durationMs : 0,
    testedAt: typeof probe.testedAt === "number" ? probe.testedAt : Date.now(),
  };
}
