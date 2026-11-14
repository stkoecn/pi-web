import { invalidateModelsCache } from "@/lib/models-cache";
import { removeStoredCredentialIfType } from "@/lib/provider-credential-store";
import { getModelRuntimeWithExtensions } from "@/lib/model-runtime";
import { getRequestDeviceId, isRemoteDevice } from "@/lib/device-context";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ provider: string }> }
) {
  const { provider } = await params;
  // A device's credential lives in the device's own auth.json: removing it
  // there is the logout, whichever type it holds (oauth tokens or an api key —
  // the panel offers logout for the entries it listed, and a device's list is
  // its models.json providers, which hold keys).
  if (isRemoteDevice(getRequestDeviceId(req))) {
    try {
      const { removeRemoteCredential } = await import("@/lib/remote-auth");
      const removal = await removeRemoteCredential(getRequestDeviceId(req), provider);
      if (removal.status === "not_found") {
        return Response.json({ error: `No stored credential for ${provider}` }, { status: 404 });
      }
      return Response.json({ ok: true });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 503 },
      );
    }
  }
  const modelRuntime = await getModelRuntimeWithExtensions();
  if (!modelRuntime.getProvider(provider)?.auth.oauth) {
    return Response.json({ error: `Unknown provider: ${provider}` }, { status: 400 });
  }
  const removal = await removeStoredCredentialIfType(provider, "oauth");
  if (removal.status === "type_mismatch") {
    return Response.json({ error: `${provider} is authenticated with an API key, not OAuth` }, { status: 409 });
  }
  invalidateModelsCache();
  return Response.json({ ok: true });
}
