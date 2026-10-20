import { NextResponse } from 'next/server';
import { getGateway } from '@/lib/gateway/singleton';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Read `devices.json` again and apply it, without restarting.
 *
 * The file is edited by hand (and is tracked by git), so the process that read
 * it at startup is normally looking at a stale list. This is the button for
 * that: it re-reads the file and connects what is new, drops what is gone, and
 * leaves every unchanged device's connection — and its open sessions — alone.
 */
export async function POST() {
  try {
    const gateway = getGateway();
    const reloaded = await gateway.reloadDevicesFromFile();

    if (reloaded.error) {
      return NextResponse.json({ error: reloaded.error, path: reloaded.path }, { status: 409 });
    }
    return NextResponse.json({
      success: true,
      path: reloaded.path,
      devices: gateway.registry.list(),
      configuredIds: reloaded.configs.map((config) => config.id),
      issues: reloaded.issues,
      sync: reloaded.sync,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
