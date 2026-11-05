import { NextResponse } from "next/server";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { generateSessionTitle } from "@/lib/session-title";
import { getRpcSession, startRpcSession } from "@/lib/rpc-manager";
import { invalidateSessionListCache, resolveSessionPath } from "@/lib/session-reader";
import { getDeviceRuntime } from "@/lib/device-runtime";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const url = new URL(req.url);
  const deviceId = url.searchParams.get("deviceId")?.trim() || undefined;

  try {
    const runtime = await getDeviceRuntime(deviceId);

    if (runtime.isRemote) {
      const { findRemoteSessionFile, readRemoteSessionContent } = await import("@/lib/remote-session-store");
      const file = await findRemoteSessionFile(deviceId!, id);
      if (!file) {
        return NextResponse.json({ error: "Session not found" }, { status: 404 });
      }

      const content = await readRemoteSessionContent(deviceId!, file);
      const tempDir = join(tmpdir(), "pi-web-autoname");
      mkdirSync(tempDir, { recursive: true });
      const tempPath = join(tempDir, `${randomUUID()}.jsonl`);
      writeFileSync(tempPath, content, "utf8");

      try {
        const tempId = `autoname_${randomUUID()}`;
        const { session } = await startRpcSession(tempId, tempPath, undefined);
        await session.waitUntilReady?.();
        const result = await generateSessionTitle(session.inner as unknown as AgentSession);
        session.destroy();

        const { renameRemoteSession } = await import("@/lib/remote-session-write");
        await renameRemoteSession(deviceId!, id, result.title);
        return NextResponse.json({ title: result.title, usage: result.usage ?? null });
      } finally {
        rmSync(tempPath, { force: true });
      }
    }

    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const existing = getRpcSession(id);
    const { session } = existing?.isAlive()
      ? { session: existing }
      : await startRpcSession(id, filePath, undefined);

    // globalThis keeps wrappers alive across dev hot reloads; older instances
    // may predate waitUntilReady(), but those have already completed startup.
    await session.waitUntilReady?.();
    const result = await generateSessionTitle(session.inner as unknown as AgentSession);

    if (!session.isAlive()) {
      return NextResponse.json(
        { error: "The session was closed while its title was being generated. Please try again." },
        { status: 409 },
      );
    }

    session.inner.setSessionName(result.title);
    invalidateSessionListCache();
    return NextResponse.json({ title: result.title, usage: result.usage ?? null });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
