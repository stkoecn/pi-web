import "server-only";
import type { IHostDriver } from "@/lib/gateway/types/host-driver";
import { getGateway } from "@/lib/gateway/singleton";
import { readRemoteFiles, writeRemoteFile } from "@/lib/remote-settings-file";
import { readRemoteModelsConfig } from "@/lib/remote-models-config";
import { getRemoteAgentDir } from "@/lib/remote-settings";
import { shellQuote } from "@/lib/shell-quote";

/**
 * A device's `auth.json` and the provider list its Models panel shows.
 *
 * The credentials live on the machine the sessions run on: a key stored here
 * would be a key for the wrong machine's requests. The file is the same
 * `{ [providerId]: Credential }` JSON pi's AuthStorage keeps, written through
 * `cat >` (which preserves the file's 0600 mode); there is no cross-SSH lock,
 * so a concurrent device-side login could race a panel write — the same single
 * user owns both.
 *
 * What the device's provider list can honestly say comes from the device's own
 * `models.json` (every entry there authenticates with a key — that is what the
 * file is) plus which of them hold a credential. pi's built-in OAuth providers
 * need the device's own runtime registry and are not listed yet.
 */

const CREDENTIAL_MIN_KEY_LENGTH = 6;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function driverFor(deviceId: string): Promise<IHostDriver> {
  return getGateway().getDriverForRequest(deviceId);
}

async function readAuthJson(driver: IHostDriver, authPath: string): Promise<Record<string, unknown>> {
  const files = await readRemoteFiles(driver, [authPath]);
  const text = files.get(authPath);
  if (!text || !text.trim()) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    // A file this module cannot parse is never replaced (the whole-draft rule
    // every agent-directory writer follows): the caller answers with an error.
    throw new Error(`Cannot parse ${authPath}`);
  }
}

export interface RemoteApiKeyProvider {
  id: string;
  displayName: string;
  configured: boolean;
  modelCount: number;
}

/** The device's models.json providers with their auth.json key state, in one read each. */
export async function listRemoteApiKeyProviders(deviceId: string): Promise<{
  apiKeyProviders: RemoteApiKeyProvider[];
  providerNames: Record<string, string>;
  authPath: string;
}> {
  const driver = await driverFor(deviceId);
  const agentDir = await getRemoteAgentDir(deviceId);
  const authPath = `${agentDir}/auth.json`;
  const [config, credentials] = await Promise.all([
    readRemoteModelsConfig(deviceId),
    readAuthJson(driver, authPath),
  ]);
  const providers = isRecord(config.providers) ? config.providers : {};
  const apiKeyProviders: RemoteApiKeyProvider[] = [];
  const providerNames: Record<string, string> = {};
  for (const [id, entry] of Object.entries(providers)) {
    if (!isRecord(entry)) continue;
    const models = Array.isArray(entry.models) ? entry.models.length : 0;
    const name = typeof entry.name === "string" && entry.name ? entry.name : id;
    providerNames[id] = name;
    const credential = credentials[id];
    const configured = isRecord(credential) && credential.type === "api_key";
    apiKeyProviders.push({ id, displayName: name, configured, modelCount: models });
  }
  return { apiKeyProviders, providerNames, authPath };
}

/** Store an api-key credential in the device's auth.json. */
export async function storeRemoteApiKey(
  deviceId: string,
  providerId: string,
  key: string,
): Promise<void> {
  const driver = await driverFor(deviceId);
  const agentDir = await getRemoteAgentDir(deviceId);
  const authPath = `${agentDir}/auth.json`;
  const credentials = await readAuthJson(driver, authPath);
  credentials[providerId] = { type: "api_key", key };
  await writeRemoteFile(driver, authPath, JSON.stringify(credentials, null, 2));
  // pi's AuthStorage keeps the file at 0600; `cat >` preserves an existing
  // file's mode, and a first-ever write needs it set once.
  await driver.exec(`chmod 600 ${shellQuote(authPath)}`, [], { timeoutMs: 10_000 });
}

export type RemoteCredentialRemoval =
  | { status: "removed" }
  | { status: "not_found" }
  | { status: "type_mismatch"; storedType: string };

/** Remove a provider's credential from the device's auth.json. */
export async function removeRemoteCredential(
  deviceId: string,
  providerId: string,
  expectedType?: "api_key" | "oauth",
): Promise<RemoteCredentialRemoval> {
  const driver = await driverFor(deviceId);
  const agentDir = await getRemoteAgentDir(deviceId);
  const authPath = `${agentDir}/auth.json`;
  const credentials = await readAuthJson(driver, authPath);
  if (!Object.hasOwn(credentials, providerId)) return { status: "not_found" };
  const stored = credentials[providerId];
  const storedType = isRecord(stored) && typeof stored.type === "string" ? stored.type : "unknown";
  if (expectedType && storedType !== expectedType) {
    return { status: "type_mismatch", storedType };
  }
  delete credentials[providerId];
  await writeRemoteFile(driver, authPath, JSON.stringify(credentials, null, 2));
  return { status: "removed" };
}

/** Whether the device holds a usable-looking credential of the given id. */
export function credentialLooksSet(credential: unknown): boolean {
  return isRecord(credential)
    && credential.type === "api_key"
    && typeof credential.key === "string"
    && credential.key.trim().length >= CREDENTIAL_MIN_KEY_LENGTH;
}
