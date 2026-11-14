import { buildApiKeyProviderList, buildOAuthProviderList } from "@/lib/provider-listing";
import { collectProviderListingInputs } from "@/lib/provider-listing-runtime";
import { getModelRuntimeWithExtensions } from "@/lib/model-runtime";
import { getRequestDeviceId, isRemoteDevice } from "@/lib/device-context";

export const dynamic = "force-dynamic";

// Providers that declare an OAuth login method, including anthropic
// (Claude Pro/Max) — see lib/provider-listing.ts (#309).
export async function GET(req: Request) {
  // A device's provider list comes from the device's own models.json and
  // auth.json (lib/remote-auth.ts): the entries a models.json defines all
  // authenticate with a key, and those are the ones the panel manages there.
  // pi's built-in OAuth providers need the device's own runtime registry and
  // are not listed for a device yet — the panel shows the key rows only.
  if (isRemoteDevice(getRequestDeviceId(req))) {
    try {
      const { listRemoteApiKeyProviders } = await import("@/lib/remote-auth");
      const { apiKeyProviders, providerNames } = await listRemoteApiKeyProviders(getRequestDeviceId(req));
      return Response.json({ providers: [], oauthProviders: [], apiKeyProviders, providerNames });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 503 },
      );
    }
  }
  const modelRuntime = await getModelRuntimeWithExtensions();
  const inputs = await collectProviderListingInputs(modelRuntime);
  const oauthProviders = buildOAuthProviderList(inputs);
  const apiKeyProviders = buildApiKeyProviderList(inputs);
  // Every runtime provider, not only those with a chat model: the Models
  // sidebar also labels a configured provider with no models (e.g. a
  // classifier-only built-in such as TypeSafe).
  const providerNames = Object.fromEntries(inputs.map((provider) => [provider.id, provider.name]));
  return Response.json({ providers: oauthProviders, oauthProviders, apiKeyProviders, providerNames });
}
