import { NextResponse } from "next/server";
import type { McpErrorResponse, McpTestResponse } from "@/lib/api-types";
import { isMcpEntryRefusal, readConnectableMcpEntry } from "@/lib/mcp-entry-request";
import { testMcpServer } from "@/lib/mcp-test";
import { getRequestDeviceId, isRemoteDevice } from "@/lib/device-context";

export const dynamic = "force-dynamic";

// Settings › MCP's Test (ADR 0006): connects one server of the global
// `mcp.json` or the panel's project `.pi/mcp.json` once, outside any session,
// and answers with what it found (`lib/mcp-test.ts`). It starts a process or
// contacts a URL, and may run a `!command` value, so it re-checks everything
// a session's start would (`readConnectableMcpEntry()`, shared with sign-in):
// MCP is not off, the entry is read from its file (never a config from the
// browser) and valid, it does not reference PI_WEB_PASSWORD, and a project
// entry's folder is allowed and trusted. A global stdio server runs in the
// panel's project when it has one (checked like any cwd), else in the home
// folder, which the answer names.
//
// A device's server runs on that machine — its command resolves there, its
// ports are its own — so a device's test runs there too
// (`lib/mcp-test-remote.ts`), with the entry read from the device's own file
// and the same answer shape.

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// POST /api/mcp/test body: { scope, name, cwd?, deviceId? }
// `cwd` is the panel's project: required for a project server, and the
// folder a global stdio server runs in. The deviceId rides the query for
// callers that can set one, and the body for the ones that cannot.
export async function POST(req: Request) {
  const queryDevice = getRequestDeviceId(req);
  let remote = isRemoteDevice(queryDevice);
  if (!remote) {
    // The panel's documented fallback carries the device in the body; a clone
    // peeks at it, because the local branch reads the body itself.
    try {
      const peek = await req.clone().json() as { deviceId?: unknown };
      remote = isRemoteDevice(typeof peek?.deviceId === "string" ? peek.deviceId.trim() : "");
    } catch {
      // No parsable body: the local branch reports what is wrong with it.
    }
  }
  if (remote) {
    const { testRemoteMcpServer } = await import("@/lib/mcp-test-remote");
    return testRemoteMcpServer(req);
  }
  const entry = await readConnectableMcpEntry(req);
  if (isMcpEntryRefusal(entry)) return NextResponse.json(entry.body, { status: entry.status });
  const { scope, name, sourcePath, configKey, config, cwd, internals } = entry;
  try {
    const result = await testMcpServer({ scope, name, sourcePath, configKey, config, cwd }, internals, { signal: req.signal });
    return NextResponse.json({ scope, name, configKey, result } satisfies McpTestResponse);
  } catch (error) {
    return NextResponse.json({ error: errorMessage(error), reason: "internal" } satisfies McpErrorResponse, { status: 500 });
  }
}
