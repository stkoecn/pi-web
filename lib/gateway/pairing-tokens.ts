import crypto from "node:crypto";

/**
 * Pairing token store for one-click device joining.
 */

export interface PairingTokenInfo {
  token: string;
  createdAt: number;
  expiresAt: number;
  suggestedId?: string;
  suggestedName?: string;
}

const TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes
const tokens = new Map<string, PairingTokenInfo>();

function sweepExpired() {
  const now = Date.now();
  for (const [key, val] of tokens.entries()) {
    if (val.expiresAt <= now) {
      tokens.delete(key);
    }
  }
}

/**
 * Creates and returns a new pairing token.
 */
export function createPairingToken(opts?: { suggestedId?: string; suggestedName?: string }): PairingTokenInfo {
  sweepExpired();
  const token = crypto.randomBytes(16).toString("hex");
  const now = Date.now();
  const info: PairingTokenInfo = {
    token,
    createdAt: now,
    expiresAt: now + TOKEN_TTL_MS,
    suggestedId: opts?.suggestedId,
    suggestedName: opts?.suggestedName,
  };
  tokens.set(token, info);
  return info;
}

/**
 * Validates a pairing token, optionally consuming it.
 */
export function validatePairingToken(token: string, consume = false): PairingTokenInfo | null {
  sweepExpired();
  if (!token) return null;
  const info = tokens.get(token);
  if (!info) return null;
  if (info.expiresAt <= Date.now()) {
    tokens.delete(token);
    return null;
  }
  if (consume) {
    tokens.delete(token);
  }
  return info;
}
