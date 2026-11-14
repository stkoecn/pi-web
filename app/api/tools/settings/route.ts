import { NextResponse } from "next/server";
import type { McpErrorResponse, McpRefusalReason, ToolSettingsResponse } from "@/lib/api-types";
import {
  CODEMODE_INLINE_BUDGET_MAX,
  isCodemodeInlineBudget,
  isCodemodeMode,
  isCodemodePreference,
  readCodemodePreference,
  readCodemodeSettings,
  writeCodemodeInlineBudget,
  writeCodemodeMode,
  writeCodemodePreference,
} from "@/lib/codemode-settings";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import {
  readBuiltinTools,
  readPowerShellToolEnabled,
  writeBuiltinTools,
  writePowerShellToolEnabled,
} from "@/lib/powershell-settings";
import { SETTINGS_BUILTIN_TOOLS } from "@/lib/tool-presets";
import { getRequestDeviceId, isRemoteDevice } from "@/lib/device-context";

export const dynamic = "force-dynamic";

// The only writer of the global `defaultTools` key: the built-in tool switches
// and the PowerShell switch (Windows) in Settings › General, and the Code mode choice (ADR 0006, chosen in Settings › MCP) both
// edit it, under the lock pi's SettingsManager takes on the same file. Settings
// › MCP saves the global `codemode.mode` and `codemode.inlineBudget` here too,
// under the same lock.
// Every refusal carries a `reason` code the panel translates, beside the
// English `error` it shows only as the diagnostic of an `internal` failure.

const CHANGES = ["enabled", "builtinTools", "codemode", "codemodeMode", "codemodeInlineBudget"] as const;

function refusal(status: number, reason: McpRefusalReason, error: string) {
  return NextResponse.json({ error, reason } satisfies McpErrorResponse, { status });
}

function errorResponse(error: unknown) {
  return refusal(500, "internal", error instanceof Error ? error.message : String(error));
}
/**
 * The validated change as a writer call against a settings path, or null when
 * the change makes no sense for the device's platform (the PowerShell switch
 * on a non-Windows device). Validation matches the local route's exactly.
 */
async function deviceChangeApplier(
  changes: { enabled?: unknown; builtinTools?: unknown; codemode?: unknown; codemodeMode?: unknown; codemodeInlineBudget?: unknown },
  platform: NodeJS.Platform,
): Promise<((settingsPath: string) => Promise<unknown>) | null> {
  const { writeBuiltinTools, writePowerShellToolEnabled } = await import("@/lib/powershell-settings");
  const {
    writeCodemodePreference,
    writeCodemodeMode,
    writeCodemodeInlineBudget,
    CODEMODE_INLINE_BUDGET_MAX,
    isCodemodeInlineBudget,
    isCodemodeMode,
    isCodemodePreference,
  } = await import("@/lib/codemode-settings");
  const { SETTINGS_BUILTIN_TOOLS } = await import("@/lib/tool-presets");

  if ("builtinTools" in changes) {
    const tools = changes.builtinTools;
    if (!Array.isArray(tools) || !tools.every((name) => SETTINGS_BUILTIN_TOOLS.includes(name))) return null;
    return (settingsPath) => writeBuiltinTools(tools as string[], settingsPath, platform);
  }
  if ("codemodeMode" in changes) {
    if (!isCodemodeMode(changes.codemodeMode)) return null;
    return (settingsPath) => writeCodemodeMode(changes.codemodeMode as "on" | "only", settingsPath);
  }
  if ("codemodeInlineBudget" in changes) {
    const budget = changes.codemodeInlineBudget;
    if (budget !== null && !isCodemodeInlineBudget(budget)) return null;
    return (settingsPath) => writeCodemodeInlineBudget((budget ?? undefined) as number | undefined, settingsPath);
  }
  if ("codemode" in changes) {
    if (!isCodemodePreference(changes.codemode)) return null;
    return (settingsPath) => writeCodemodePreference(changes.codemode as "automatic" | "always", settingsPath);
  }
  if ("enabled" in changes) {
    if (platform !== "win32") return null;
    if (typeof changes.enabled !== "boolean") return null;
    return (settingsPath) => writePowerShellToolEnabled(changes.enabled as boolean, settingsPath, platform);
  }
  return null;
}

async function readToolSettings(): Promise<ToolSettingsResponse> {
  // One after the other: each takes the file lock, and a reader that finds it
  // held backs off for about a second.
  const powerShellEnabled = await readPowerShellToolEnabled();
  const builtinTools = await readBuiltinTools();
  const codemode = await readCodemodePreference();
  const { mode: codemodeMode, inlineBudget: codemodeInlineBudget } = await readCodemodeSettings();
  return { isWindows: process.platform === "win32", powerShellEnabled, builtinTools, codemode, codemodeMode, codemodeInlineBudget };
}

/**
 * The device's own global settings.json, edited through the same writers the
 * local route runs: the file is downloaded, the writer takes that path (they
 * all accept one), and the bytes go back under `cat >` (mode preserved). The
 * PowerShell switch follows the DEVICE's platform — a Linux device has no
 * PowerShell tool to switch.
 */
async function readDeviceToolSettings(deviceId: string, settingsPath: string): Promise<ToolSettingsResponse> {
  const { getGateway } = await import("@/lib/gateway/singleton");
  const { withRemoteSettingsFile } = await import("@/lib/remote-subagents");
  const { readPowerShellToolEnabled, readBuiltinTools } = await import("@/lib/powershell-settings");
  const { readCodemodePreference, readCodemodeSettings } = await import("@/lib/codemode-settings");
  const platform = await devicePlatform(deviceId);
  const driver = await getGateway().getDriverForRequest(deviceId);
  await withRemoteSettingsFile(driver, settingsPath, async () => {});
  const powerShellEnabled = await readPowerShellToolEnabled(settingsPath, platform);
  const builtinTools = await readBuiltinTools(settingsPath, platform);
  const codemode = await readCodemodePreference(settingsPath);
  const { mode: codemodeMode, inlineBudget: codemodeInlineBudget } = await readCodemodeSettings(settingsPath);
  return { isWindows: platform === "win32", powerShellEnabled, builtinTools, codemode, codemodeMode, codemodeInlineBudget };
}

async function devicePlatform(deviceId: string): Promise<NodeJS.Platform> {
  const { getGateway } = await import("@/lib/gateway/singleton");
  const driver = await getGateway().getDriverForRequest(deviceId);
  const result = await driver.exec("uname -s 2>/dev/null || echo Windows_NT", [], { timeoutMs: 10_000 });
  const kernel = result.stdout.trim().toLowerCase();
  if (kernel.includes("darwin")) return "darwin";
  if (kernel.includes("windows") || kernel.includes("windows_nt")) return "win32";
  return "linux";
}

/** One settings change against the device's file, through the local writers. */
async function writeDeviceToolSetting(
  deviceId: string,
  settingsPath: string,
  apply: (settingsPath: string) => Promise<void>,
): Promise<void> {
  const { getGateway } = await import("@/lib/gateway/singleton");
  const { withRemoteSettingsFile } = await import("@/lib/remote-subagents");
  const driver = await getGateway().getDriverForRequest(deviceId);
  await withRemoteSettingsFile(driver, settingsPath, (tempPath) => apply(tempPath));
}

export async function GET(req: Request) {
  const deviceId = getRequestDeviceId(req);
  if (isRemoteDevice(deviceId)) {
    try {
      const { getRemoteAgentDir } = await import("@/lib/remote-settings");
      const settingsPath = `${await getRemoteAgentDir(deviceId)}/settings.json`;
      return NextResponse.json(await readDeviceToolSettings(deviceId, settingsPath));
    } catch (error) {
      return errorResponse(error);
    }
  }
  try {
    return NextResponse.json(await readToolSettings());
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return refusal(403, "request-denied", "Untrusted API request");
  }
  if (!hasJsonContentType(req)) {
    return refusal(415, "content-type", "Content-Type must be application/json");
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return refusal(400, "invalid-request", "Invalid JSON body");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return refusal(400, "invalid-request", "Expected a JSON object");
  }
  const changes = body as { enabled?: unknown; builtinTools?: unknown; codemode?: unknown; codemodeMode?: unknown; codemodeInlineBudget?: unknown };
  if (CHANGES.filter((key) => key in changes).length !== 1) {
    return refusal(400, "invalid-request", "Send one of enabled (PowerShell), builtinTools, codemode, codemodeMode or codemodeInlineBudget");
  }

  if ("builtinTools" in changes) {
    // The built-in tools new sessions start with; every other defaultTools entry is kept.
    const tools = changes.builtinTools;
    if (!Array.isArray(tools) || !tools.every((name) => SETTINGS_BUILTIN_TOOLS.includes(name))) {
      return refusal(400, "invalid-request", `builtinTools must list names from ${SETTINGS_BUILTIN_TOOLS.join(", ")}`);
    }
    try {
      await writeBuiltinTools(tools);
      return NextResponse.json(await readToolSettings());
    } catch (error) {
      return errorResponse(error);
    }
  }

  if ("codemodeMode" in changes) {
    // "on" removes the key: it is pi's default.
    if (!isCodemodeMode(changes.codemodeMode)) {
      return refusal(400, "invalid-request", "codemodeMode must be \"on\" or \"only\"");
    }
    try {
      await writeCodemodeMode(changes.codemodeMode);
      return NextResponse.json(await readToolSettings());
    } catch (error) {
      return errorResponse(error);
    }
  }

  if ("codemodeInlineBudget" in changes) {
    // null removes the key, which gives sessions pi's default.
    const budget = changes.codemodeInlineBudget;
    if (budget !== null && !isCodemodeInlineBudget(budget)) {
      return refusal(400, "invalid-request", `codemodeInlineBudget must be a whole number from 0 to ${CODEMODE_INLINE_BUDGET_MAX}, or null`);
    }
    try {
      await writeCodemodeInlineBudget(budget ?? undefined);
      return NextResponse.json(await readToolSettings());
    } catch (error) {
      return errorResponse(error);
    }
  }

  if ("codemode" in changes) {
    if (!isCodemodePreference(changes.codemode)) {
      return refusal(400, "invalid-request", "codemode must be \"automatic\" or \"always\"");
    }
    try {
      await writeCodemodePreference(changes.codemode);
      return NextResponse.json(await readToolSettings());
    } catch (error) {
      return errorResponse(error);
    }
  }

  if (process.platform !== "win32") {
    return refusal(404, "invalid-request", "PowerShell tool settings are only available on Windows");
  }
  if (typeof changes.enabled !== "boolean") {
    return refusal(400, "invalid-request", "enabled must be a boolean");
  }
  try {
    await writePowerShellToolEnabled(changes.enabled);
    return NextResponse.json(await readToolSettings());
  } catch (error) {
    return errorResponse(error);
  }
}
