/**
 * The client's record that signing mode is on. (P028)
 *
 * This is BOOKKEEPING, NOT SECURITY. The lock is the narrowed session token the server issued —
 * clearing this key does not widen it, and the CRM still answers 403 to a signing token no matter
 * what the browser believes. What this exists for is that a reload, a rotate, or a swipe-away must
 * land back in signing mode rather than in a half-rendered CRM the customer is holding.
 *
 * It is stored next to the token deliberately: `rce_token` holds the signing-scoped credential
 * while this is set, and both are replaced together when the operator's PIN mints a full session.
 */

const KEY = "rce_signing";

/** Idle before the screen drops to the PIN lock. The server token outlives this on purpose,
 *  so the fallback is a lock the operator can open — not an expiry the customer sees. */
export const IDLE_LIMIT_MS = 5 * 60 * 1000;

export interface SigningSession {
  estimateId: string;
  number: string;
  startedAt: number;
  lastActivity: number;
}

export function readSigningSession(): SigningSession | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SigningSession;
    if (!parsed?.estimateId) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function startSigningSession(estimateId: string, number: string): void {
  const now = Date.now();
  localStorage.setItem(
    KEY,
    JSON.stringify({ estimateId, number, startedAt: now, lastActivity: now } satisfies SigningSession)
  );
}

export function touchSigningSession(): void {
  const s = readSigningSession();
  if (!s) return;
  localStorage.setItem(KEY, JSON.stringify({ ...s, lastActivity: Date.now() }));
}

export function clearSigningSession(): void {
  localStorage.removeItem(KEY);
}

export function isSigningModeActive(): boolean {
  return readSigningSession() !== null;
}
