import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { getRequestDeviceId, isRemoteDevice } from "@/lib/device-context";
import { isProviderUsageId, queryProviderUsage } from "@/lib/provider-usage";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(request)) return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });

  let body: { providerId?: unknown };
  try {
    body = await request.json() as { providerId?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const providerId = typeof body.providerId === "string" ? body.providerId : "";
  if (!isProviderUsageId(providerId)) return NextResponse.json({ error: "Unsupported provider" }, { status: 400 });
  // The query authenticates with the key stored for that provider — on a
  // device, the device's own auth.json. Running the per-provider request here
  // would read this host's keys instead. Until the query runs on the device,
  // answer the refusal the panel already renders as a failed status.
  if (isRemoteDevice(getRequestDeviceId(request))) {
    return NextResponse.json(
      { error: "Provider usage is queried with this host's stored credentials; a device's keys are not queried yet.", reason: "remote-unsupported" },
      { status: 501 },
    );
  }

  try {
    const result = await queryProviderUsage(providerId);
    return NextResponse.json(result);
  } catch {
    return NextResponse.json({
      providerId,
      status: "query-failed",
      message: "The provider usage query failed.",
    });
  }
}
