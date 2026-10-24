import { isIP } from "node:net";
import { hostname as osHostname } from "node:os";

function normalizeHostname(value: string): string {
  const unbracketed = value.startsWith("[") && value.endsWith("]")
    ? value.slice(1, -1)
    : value;
  return unbracketed.toLowerCase().replace(/\.$/, "");
}

function hostnameFromAuthority(value: string): string | null {
  if (!value || /[\s/@\\]/.test(value)) return null;
  try {
    const parsed = new URL(`http://${value}`);
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      return null;
    }
    return normalizeHostname(parsed.hostname);
  } catch {
    return null;
  }
}

function normalizeAuthority(value: string): string | null {
  if (!value || /[\s/@\\]/.test(value)) return null;
  try {
    const parsed = new URL(`http://${value}`);
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      return null;
    }
    const hostname = normalizeHostname(parsed.hostname);
    return parsed.port ? `${hostname}:${parsed.port}` : hostname;
  } catch {
    return null;
  }
}

function normalizeConfiguredHostname(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return isIP(trimmed) ? normalizeHostname(trimmed) : hostnameFromAuthority(trimmed);
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost");
}

function configuredHostnamesFromEnvironment(): string[] {
  return [
    process.env.PI_WEB_HOSTNAME,
    ...(process.env.PI_WEB_ALLOWED_HOSTS?.split(",") ?? []),
    ...ownHostnames(),
  ].filter((value): value is string => Boolean(value?.trim()));
}

/**
 * Names that resolve to this machine: its OS hostname, that name's first label
 * (what a LAN browser usually types), and the mDNS `*.local` form macOS and
 * Windows advertise.
 *
 * Accepting them is not a weakening of the DNS-rebinding guard. That guard
 * exists because an attacker-controlled name can be pointed at 127.0.0.1; a
 * name the operator types for their own machine is exactly the thing the guard
 * must not block, and requiring a hand-maintained PI_WEB_ALLOWED_HOSTS entry
 * for it made every write API answer 403 "Untrusted API request" while reads
 * (which skip this check) worked — a bug that looks like a permissions fault.
 */
function ownHostnames(): string[] {
  const full = osHostname().trim().toLowerCase();
  if (!full) return [];
  const names = new Set([full]);
  const short = full.split(".")[0];
  if (short) {
    names.add(short);
    names.add(`${short}.local`);
  }
  return [...names];
}

function canonicalOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function getRequestOrigin(request: Request): string | null {
  const requestUrl = new URL(request.url);
  const host = request.headers.get("host");
  return host ? canonicalOrigin(`${requestUrl.protocol}//${host}`) : null;
}

function isPdfFileReadUrl(url: URL): boolean {
  if (!url.pathname.startsWith("/api/files/") || url.searchParams.get("type") !== "read") return false;
  const lastSegment = url.pathname.slice(url.pathname.lastIndexOf("/") + 1);
  try {
    return decodeURIComponent(lastSegment).toLowerCase().endsWith(".pdf");
  } catch {
    return false;
  }
}

/**
 * A top-level GET the user clicked can arrive marked cross-site with no Origin
 * when the page holding the link has an opaque origin: a PWA's own window
 * opening the session export, or Android Chrome's `data:` placeholder for a PDF
 * it will not render in the viewer's iframe (#1298). Only routes with no side
 * effect whose response cannot run script in the Pi Web origin qualify: the
 * export page (framing denied) and `type=read` of a `.pdf`, which the route
 * always serves as `application/pdf` with nosniff. The opening page cannot
 * read either response.
 */
function isUserInitiatedDocumentNavigation(request: Request): boolean {
  if (
    request.method !== "GET"
    || request.headers.get("sec-fetch-mode") !== "navigate"
    || request.headers.get("sec-fetch-dest") !== "document"
    || request.headers.get("sec-fetch-user") !== "?1"
  ) {
    return false;
  }

  try {
    const url = new URL(request.url);
    return /^\/api\/sessions\/[^/]+\/export$/.test(url.pathname) || isPdfFileReadUrl(url);
  } catch {
    return false;
  }
}

/**
 * Only trust local names, IP literals, or the hostname explicitly selected by
 * the operator. IP literals preserve LAN access but cannot be DNS-rebound
 * because the browser keeps the literal address in the Host header.
 */
export function isApiRequestHostAllowed(
  request: Request,
  configuredHostnames = configuredHostnamesFromEnvironment(),
): boolean {
  const host = request.headers.get("host");
  const hostname = host ? hostnameFromAuthority(host) : null;
  if (!hostname) return false;
  if (isLoopbackHostname(hostname) || isIP(hostname)) return true;

  return configuredHostnames.some(
    (configured) => normalizeConfiguredHostname(configured) === hostname,
  );
}

/**
 * Names the Host check refuses, for a one-line diagnostic.
 *
 * Without it the operator sees "Untrusted API request" and has to read this
 * module to learn that the browser's hostname is the whole problem.
 */
export function describeRejectedHost(request: Request): string | null {
  const host = request.headers.get("host");
  if (!host) return "the request has no Host header";
  const hostname = hostnameFromAuthority(host);
  if (!hostname) return `Host "${host}" is not a valid authority`;
  if (isLoopbackHostname(hostname) || isIP(hostname)) return null;
  return `Host "${hostname}" is not a loopback name, an IP literal, or a configured `
    + `hostname. Add it to PI_WEB_ALLOWED_HOSTS (comma-separated) to use it.`;
}

/**
 * A relay can report the external scheme in `x-forwarded-proto` while rewriting
 * `Origin` onto the backend authority, so the two disagree on the scheme alone
 * for a request that really is same-origin (Azure Dev Tunnels does this). Accept
 * that pairing only when the Origin's authority still equals the Host header,
 * a proxy is in front, and Fetch Metadata still reports a same-origin request.
 */
function isProxyRewrittenSameOrigin(request: Request, origin: string): boolean {
  if (
    request.headers.get("sec-fetch-site") !== "same-origin"
    || !request.headers.get("x-forwarded-proto")
  ) return false;

  const host = request.headers.get("host");
  if (!host) return false;

  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }

  const originAuthority = normalizeAuthority(originHost);
  return originAuthority !== null && originAuthority === normalizeAuthority(host);
}

/** Reject browser cross-site API requests while preserving non-browser clients. */
export function isApiRequestOriginAllowed(request: Request): boolean {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite === "cross-site") return false;
  if (!origin) return true;

  const requestOrigin = getRequestOrigin(request);
  if (requestOrigin !== null && canonicalOrigin(origin) === requestOrigin) return true;

  return isProxyRewrittenSameOrigin(request, origin);
}

export function shouldCheckApiRequestOrigin(request: Request): boolean {
  return request.headers.has("origin") || request.headers.has("sec-fetch-site");
}

export function isApiRequestAllowed(
  request: Request,
  configuredHostnames = configuredHostnamesFromEnvironment(),
): boolean {
  if (!isApiRequestHostAllowed(request, configuredHostnames)) {
    reportRejectedHostOnce(request);
    return false;
  }
  if (isUserInitiatedDocumentNavigation(request)) return true;
  return !shouldCheckApiRequestOrigin(request) || isApiRequestOriginAllowed(request);
}

// One line per distinct refused hostname, not one per request: the sidebar polls
// several gated routes, and a repeating warning buries its own message.
const reportedHosts = new Set<string>();

function reportRejectedHostOnce(request: Request): void {
  const host = request.headers.get("host") ?? "(none)";
  if (reportedHosts.has(host)) return;
  reportedHosts.add(host);
  const detail = describeRejectedHost(request);
  if (detail) console.warn(`[pi-web] Refused an API write: ${detail}`);
}

export function hasJsonContentType(request: Request): boolean {
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/json"
    || Boolean(mediaType?.startsWith("application/") && mediaType.endsWith("+json"));
}
