import { NextResponse } from "next/server";
import { getRequestDeviceId, isRemoteDevice } from "@/lib/device-context";
import { getDeviceHome } from "@/lib/device-home";

// GET /api/home - the home directory shown as `~` in the path menus.
//
// It has to be the device's home, not this host's: a remote device answers
// `/root` on a Linux VPS and `/Users/<name>` on macOS, and abbreviating either
// with `D:\Users\winds` would be nonsense.
export async function GET(req: Request) {
  const deviceId = getRequestDeviceId(req);
  const home = await getDeviceHome(deviceId);
  if (home) return NextResponse.json({ home });
  // Offline or unanswerable device: `/` is the one path every POSIX device has.
  // Falling back to `/root` silently pointed macOS at a directory that does not
  // exist, so the session and file panels opened empty instead of erroring.
  return NextResponse.json({ home: isRemoteDevice(deviceId) ? "/" : null });
}
