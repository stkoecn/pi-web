/**
 * Retrying SSH channel opens that the server refused.
 *
 * sshd answers a channel open with `open failed` — ssh2 surfaces it as
 * `(SSH) Channel open failure: open failed` — when the connection already
 * holds `MaxSessions` channels (10 by default, counted across ALL consumers of
 * the one connection). The budget is shared by the command shell pool, the
 * long-lived SFTP channel, every terminal, and one `exec` channel per open
 * remote session, so saturation is a transient condition, not a broken device:
 * a session that closes or a pool shell that finishes frees a slot within
 * moments.
 *
 * Treating that refusal as fatal made `POST /api/agent/new` fail about one time
 * in three against a device with several sessions open, and the user saw an
 * SSH error where a new session should have appeared. A short retry turns the
 * same condition into a slightly slower success.
 */

/** The refusal above, and the related transport drops a busy server can send. */
export function isChannelOpenFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return (
    /Channel open failure/i.test(message)
    || /open failed/i.test(message)
    || /open failure/i.test(message)
    || /resource shortage/i.test(message)
    // A server that reaches MaxStartups drops the handshake instead.
    || /MaxSessions|administratively prohibited/i.test(message)
  );
}

export interface ChannelRetryOptions {
  /** Total attempts, including the first. */
  attempts?: number;
  /** Wait before the first retry; doubles on each further one. */
  baseDelayMs?: number;
}

/** `open` again while the server is refusing channels, then let the error out. */
export async function withChannelRetry<T>(
  open: () => Promise<T>,
  options: ChannelRetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 4);
  const baseDelayMs = Math.max(1, options.baseDelayMs ?? 120);
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await open();
    } catch (error) {
      lastError = error;
      if (!isChannelOpenFailure(error) || attempt === attempts - 1) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, baseDelayMs * 2 ** attempt));
    }
  }
  throw lastError;
}
