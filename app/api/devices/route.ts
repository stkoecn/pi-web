import { NextResponse } from 'next/server';
import { getGateway } from '@/lib/gateway/singleton';
import { sshHostToDevice } from '@/lib/gateway/ssh-config';
import {
  addDeviceToConfigs,
  publicDeviceConfig,
  readDevicesFile,
  removeDeviceFromConfigs,
  updateDeviceInConfigs,
  writeDevicesFile,
  type DeviceConfigInput,
} from '@/lib/gateway/device-config-file';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function failure(error: unknown, status = 500) {
  return NextResponse.json(
    { error: error instanceof Error ? error.message : String(error) },
    { status },
  );
}

/**
 * The devices this gateway serves, plus what `devices.json` said.
 *
 * `issues` is not decoration: a device whose line is wrong is absent from
 * `devices`, and without the reason the only symptom is a host that never
 * appears. The file path and the saved entries are included so the settings
 * pane can show and edit the file itself. Passwords and key contents never
 * leave this process; a saved device reports `hasPassword` instead.
 *
 * `devices` includes configured devices that have not connected yet, so a
 * reverse-tunnel host the user added is visible while it waits to dial in.
 */
export async function GET() {
  try {
    const gateway = getGateway();
    const file = readDevicesFile(gateway.configPath());
    // `~/.ssh/config` already says which machines this user reaches, and with
    // which user, port and key. Listing those here means nobody retypes them;
    // `configs` stays the file's own entries, so the pane can still tell the
    // two apart (a discovered host has no `hasPassword`, no mode, and cannot be
    // edited or deleted until it is added).
    const ssh = gateway.readSshHosts();
    const enabledDefault = gateway.readEnabledDefault();
    const configured = new Set(file.configs.map((config) => config.id));
    return NextResponse.json({
      devices: gateway.listDevices(),
      configPath: file.path,
      configs: file.configs.map(publicDeviceConfig),
      issues: file.issues,
      sshConfigPath: ssh.path,
      sshHosts: ssh.hosts.map((host) => {
        const config = sshHostToDevice(host);
        return {
          id: config.id,
          name: host.alias,
          host: config.host,
          port: config.port,
          username: config.username,
          ...(config.privateKeyPath ? { privateKeyPath: config.privateKeyPath } : {}),
          configured: configured.has(config.id),
          // A discovered host is offered but inert until the user turns it on;
          // `devices.json` entries are the request itself and have no switch.
          enabled: configured.has(config.id) ? true : gateway.isDeviceEnabled(config.id),
          // The hops `ProxyJump` names, so the pane can say how it will be
          // reached instead of leaving the address looking unreachable.
          ...(host.jump && host.jump.length > 0
            ? { jump: host.jump.map((hop) => `${hop.username}@${hop.host}:${hop.port}`) }
            : {}),
          ...(host.unsupported ? { unsupported: host.unsupported } : {}),
        };
      }),
      sshProblems: ssh.problems,
      sshEnabledDefault: enabledDefault,
      ...(ssh.error ? { sshError: ssh.error } : {}),
      ...(file.error ? { fileError: file.error } : {}),
    });
  } catch (error) {
    return failure(error);
  }
}

async function readBody(req: Request): Promise<DeviceConfigInput | null> {
  try {
    const body: unknown = await req.json();
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
    return body as DeviceConfigInput;
  } catch {
    return null;
  }
}

/** Add a device: write it to the file, then connect it. */
export async function POST(req: Request) {
  try {
    const body = await readBody(req);
    if (!body) return NextResponse.json({ error: 'Missing required device fields' }, { status: 400 });

    const gateway = getGateway();
    const file = readDevicesFile(gateway.configPath());
    if (file.error) return NextResponse.json({ error: file.error }, { status: 409 });

    // A host the gateway dials is not stored here any more: `~/.ssh/config`
    // already says which machines this user reaches, with which user, port and
    // key. Writing a second copy would drift the moment either file changed, so
    // the only entry this endpoint accepts is the one ssh cannot describe — a
    // machine behind NAT that dials in.
    if (body.mode !== undefined && body.mode !== 'reverse_tunnel') {
      return NextResponse.json(
        { error: 'Only reverse tunnels are saved here; a dialled host is read from ~/.ssh/config' },
        { status: 400 },
      );
    }
    const added = addDeviceToConfigs(file.configs, { ...body, mode: 'reverse_tunnel' });
    if ('reason' in added) {
      const status = added.reason.includes('already exists') ? 409 : 400;
      return NextResponse.json({ error: added.reason }, { status });
    }

    writeDevicesFile(added.configs, file.path);
    await gateway.syncDevices(added.configs);
    const saved = gateway.listConfiguredDevices().find((config) => config.id === added.config.id)
      ?? added.config;
    return NextResponse.json({
      success: true,
      deviceId: saved.id,
      config: publicDeviceConfig(saved),
      // Key *contents* are not written to a file git tracks, so an add that
      // carried them lives only until the process restarts. Say so here rather
      // than let it fail later as an authentication error.
      ...(typeof (body as { privateKey?: unknown }).privateKey === 'string'
        ? { warning: 'privateKey contents are not saved to devices.json; use privateKeyPath to persist this device' }
        : {}),
    });
  } catch (error) {
    return failure(error);
  }
}

/** Edit a device in place. The id is the key everything else stores, so it may not change. */
export async function PUT(req: Request) {
  try {
    const body = await readBody(req);
    if (!body) return NextResponse.json({ error: 'Missing required device fields' }, { status: 400 });

    const gateway = getGateway();
    const file = readDevicesFile(gateway.configPath());
    if (file.error) return NextResponse.json({ error: file.error }, { status: 409 });

    if (body.mode !== undefined && body.mode !== 'reverse_tunnel') {
      return NextResponse.json(
        { error: 'Only reverse tunnels are saved here; a dialled host is read from ~/.ssh/config' },
        { status: 400 },
      );
    }
    const updated = updateDeviceInConfigs(file.configs, body);
    if ('reason' in updated) {
      const status = updated.reason.startsWith('no device') ? 404 : 400;
      return NextResponse.json({ error: updated.reason }, { status });
    }

    writeDevicesFile(updated.configs, file.path);
    await gateway.syncDevices(updated.configs);
    return NextResponse.json({
      success: true,
      deviceId: updated.config.id,
      config: publicDeviceConfig(updated.config),
    });
  } catch (error) {
    return failure(error);
  }
}

export async function DELETE(req: Request) {
  try {
    const url = new URL(req.url);
    const id = url.searchParams.get('id');
    if (!id) return NextResponse.json({ error: 'Device id required' }, { status: 400 });
    if (id === 'localhost') return NextResponse.json({ error: 'Cannot remove localhost' }, { status: 400 });

    const gateway = getGateway();
    const file = readDevicesFile(gateway.configPath());
    if (file.error) return NextResponse.json({ error: file.error }, { status: 409 });

    const removed = removeDeviceFromConfigs(file.configs, id);
    if ('reason' in removed) {
      return NextResponse.json({ error: removed.reason }, { status: 404 });
    }

    writeDevicesFile(removed.configs, file.path);
    await gateway.syncDevices(removed.configs);
    return NextResponse.json({ success: true });
  } catch (error) {
    return failure(error);
  }
}
