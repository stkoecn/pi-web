/**
 * Device scoping for every API route.
 *
 * A request is either device-blind (`localhost`, the in-process host) or
 * addressed at a gateway device. The convention is deliberately boring so a
 * browser can use it everywhere, including `EventSource` (which cannot set
 * headers):
 *
 *   1. `?deviceId=<id>` query parameter, or
 *   2. `x-device-id` request header.
 *
 * Anything that is not the literal `localhost` is a remote device and must be
 * served through the gateway driver instead of `node:fs` / `node-pty`.
 */

export const LOCAL_DEVICE_ID = "localhost";

/** Device id for this request; `localhost` when the request is device-blind. */
export function getRequestDeviceId(
  req: Request,
  searchParams?: URLSearchParams,
): string {
  // Some callers (integration tests, internal dispatchers) hand us a request-like
  // object with no `url`; reading it unconditionally crashed the route.
  const url = typeof req?.url === "string" ? req.url : "";
  const fromQuery = (searchParams ?? (url ? new URL(url).searchParams : new URLSearchParams())).get("deviceId");
  const raw = fromQuery ?? req?.headers?.get?.("x-device-id") ?? null;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : LOCAL_DEVICE_ID;
}

/** True when the id names a gateway device rather than the in-process host. */
export function isRemoteDevice(deviceId: string | null | undefined): deviceId is string {
  return Boolean(deviceId) && deviceId !== LOCAL_DEVICE_ID;
}

/**
 * Append `deviceId` to a URL when it is remote. Local URLs stay byte-identical
 * to the pre-gateway form so existing caches and tests keep matching.
 */
export function withDeviceId(url: string, deviceId: string | null | undefined): string {
  if (!isRemoteDevice(deviceId)) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}deviceId=${encodeURIComponent(deviceId)}`;
}

/**
 * Browser-side navigation URL that keeps the selected device.
 *
 * `router.replace("?session=…")` drops every other query parameter, including
 * `deviceId`, so selecting a remote session silently fell back to localhost on
 * the next render. Every navigation in the shell must be built with this.
 *
 * `params` is the full new query for the current pathname; `null` clears it.
 * The device survives unless `params` already names one.
 */
export function deviceAwareHref(
  params: URLSearchParams | Record<string, string | number | null | undefined> | string | null,
  deviceId: string | null | undefined,
  pathname?: string,
): string {
  const search = new URLSearchParams();
  if (params instanceof URLSearchParams) {
    for (const [key, value] of params) search.append(key, value);
  } else if (typeof params === "string") {
    for (const [key, value] of new URLSearchParams(params)) search.append(key, value);
  } else if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== null && value !== undefined && value !== "") search.set(key, String(value));
    }
  }
  if (!search.has("deviceId") && isRemoteDevice(deviceId)) {
    search.set("deviceId", deviceId);
  }
  const query = search.toString();
  const base = pathname ?? (typeof window !== "undefined" ? window.location.pathname : "/");
  return query ? `${base}?${query}` : base;
}
