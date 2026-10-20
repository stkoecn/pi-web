/**
 * Next.js calls this once when the server starts, before the first request.
 *
 * The gateway is otherwise created lazily by whichever route happens to be hit
 * first, so the first page load paid the whole SSH handshake (2-5 s on a WAN
 * device) inside a request. Warming it here moves that cost to server start,
 * where nobody is waiting on it.
 */
export async function register(): Promise<void> {
  // Only the Node runtime can hold sockets; the edge runtime must not try.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { getGateway } = await import("@/lib/gateway/singleton");
    // Fire and forget: a device that is offline must not delay server start,
    // and the SSH pool retries on its own schedule.
    void getGateway();
  } catch {
    // A gateway that fails to start must not stop the web server.
  }
}
