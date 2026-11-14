import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

export const TEST_TIMEOUT_MS = 20_000;

export interface TestModelPayload {
  providerName: string;
  provider: Record<string, unknown>;
  model: Record<string, unknown>;
  modelId: string;
}

export interface TestModelResult {
  ok: boolean;
  error?: string;
  latencyMs?: number;
  status?: number;
  responseText?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readTestModelPayload(body: unknown): TestModelPayload | { error: string; status: number } {
  const bodyRecord = isRecord(body) ? body : {};
  const providerName = typeof bodyRecord.providerName === "string" ? bodyRecord.providerName.trim() : "";
  if (!providerName) return { error: "providerName is required", status: 400 };
  if (!isRecord(bodyRecord.provider)) return { error: "provider is required", status: 400 };
  if (!isRecord(bodyRecord.model)) return { error: "model is required", status: 400 };
  const modelId = typeof bodyRecord.model.id === "string" ? bodyRecord.model.id.trim() : "";
  if (!modelId) return { error: "Model ID is required", status: 400 };
  return { providerName, provider: bodyRecord.provider, model: bodyRecord.model, modelId };
}

function getAssistantText(message: AssistantMessage): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

/**
 * The model probe as the local runtime runs it: a temp models.json holding just
 * the provider under test, then pi's ModelRuntime answers one tiny chat request.
 * The remote runtime runs the same probe on the device with the device's own pi
 * build (lib/model-test-device-script.ts), so both environments answer alike.
 */
export async function testModelConfigLocally(payload: TestModelPayload): Promise<TestModelResult> {
  let tempDir: string | undefined;
  try {
    tempDir = mkdtempSync(join(tmpdir(), "pi-web-model-test-"));
    const modelsPath = join(tempDir, "models.json");
    writeFileSync(modelsPath, JSON.stringify({
      providers: {
        [payload.providerName]: {
          ...payload.provider,
          models: [{ ...payload.model, id: payload.modelId }],
        },
      },
    }, null, 2), "utf8");

    const modelRuntime = await ModelRuntime.create({ modelsPath });
    const loadError = modelRuntime.getError();
    if (loadError) return { ok: false, error: loadError };

    const model = modelRuntime.getModel(payload.providerName, payload.modelId);
    if (!model) return { ok: false, error: `Model not found: ${payload.providerName}/${payload.modelId}` };

    // A status check, not getAuth(): the request resolves auth itself, so a `!command` key runs once.
    if (!modelRuntime.getProviderAuthStatus(payload.providerName).configured) {
      return { ok: false, error: `No API key found for "${payload.providerName}"` };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
    let status: number | undefined;
    const startedAt = Date.now();

    try {
      // The runtime adds the auth, models.json and session headers a chat request gets
      // (opencode.ai refuses a request without x-opencode-session). One fresh id per probe.
      const message = await modelRuntime.completeSimple(model, {
        messages: [{
          role: "user",
          content: "Reply with OK only.",
          timestamp: Date.now(),
        }],
      }, {
        sessionId: randomUUID(),
        maxTokens: 16,
        timeoutMs: TEST_TIMEOUT_MS,
        maxRetries: 0,
        cacheRetention: "none",
        signal: controller.signal,
        onResponse: (response) => { status = response.status; },
      });

      const latencyMs = Date.now() - startedAt;
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        return {
          ok: false,
          error: message.errorMessage ?? (controller.signal.aborted ? "Test timed out" : "Model returned an error"),
          latencyMs,
          status,
        };
      }

      return {
        ok: true,
        latencyMs,
        status,
        responseText: getAssistantText(message).slice(0, 300),
      };
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  }
}
