import { NextResponse } from 'next/server';
import { getGateway } from '@/lib/gateway/singleton';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  try {
    const gateway = getGateway();
    const devices = gateway.registry.list();
    return NextResponse.json({ devices });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const gateway = getGateway();
    if (!body.id || !body.host || !body.username) {
      return NextResponse.json({ error: 'Missing required device fields' }, { status: 400 });
    }
    await gateway.clientPool.addDevice({
      id: body.id,
      name: body.name || body.id,
      host: body.host,
      port: body.port || 22,
      username: body.username,
      password: body.password,
      privateKey: body.privateKey,
      privateKeyPath: body.privateKeyPath,
      mode: 'active_ssh',
    });
    return NextResponse.json({ success: true, deviceId: body.id });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}

export async function DELETE(req: Request) {
  try {
    const url = new URL(req.url);
    const id = url.searchParams.get('id');
    if (!id) return NextResponse.json({ error: 'Device id required' }, { status: 400 });
    if (id === 'localhost') return NextResponse.json({ error: 'Cannot remove localhost' }, { status: 400 });

    const gateway = getGateway();
    await gateway.clientPool.removeDevice(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
