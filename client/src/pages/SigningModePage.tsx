/**
 * Signing mode — the customer is holding the operator's phone. (P028)
 *
 * Kyle's ruling: *"I want them to be able to view the quote in app and sign there as the first
 * option."* This is that screen, and it is deliberately not a page so much as a lock.
 *
 * WHAT MAKES IT A LOCK, in order of how much each part actually carries:
 *
 *   1. **The session is narrowed on the SERVER.** Entering signing mode swapped the full owner
 *      token for one scoped to this single estimate (`middleware/signingScope.ts`). Every other
 *      route in the application answers 403 to it — including this same route for a different
 *      estimate. Everything below is convenience on top of that; the security is there.
 *   2. **No router, no shell.** `App.tsx` short-circuits to this component for every path while
 *      signing mode is on, so there is no navigation to hide and no route to reach.
 *   3. **Back does not leave.** A history entry is pushed on entry and re-pushed on `popstate`.
 *   4. **Idle drops to the PIN lock, never into the CRM.** The server token also expires on its
 *      own, so an abandoned phone degrades to a dead session rather than an open one.
 *   5. **Exit needs the PIN**, because the PIN is the only thing that mints a full session.
 *
 * The estimate itself is rendered by the SERVER — the same `renderEstimatePage` the emailed link
 * uses — and shown in a sandboxed iframe. Rebuilding the document in React would have created a
 * second place for hours to leak into, which is exactly what the shared-render rule forbids.
 */

import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../lib/api";
import {
  clearSigningSession,
  readSigningSession,
  touchSigningSession,
  IDLE_LIMIT_MS,
} from "../lib/signingSession";

type Phase = "reviewing" | "signed" | "locked";

export function SigningModePage() {
  const session = readSigningSession();
  const [phase, setPhase] = useState<Phase>("reviewing");
  const [html, setHtml] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [signerName, setSignerName] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [signError, setSignError] = useState<string | null>(null);
  const [signing, setSigning] = useState(false);

  const [pin, setPin] = useState("");
  const [pinError, setPinError] = useState<string | null>(null);
  const [unlocking, setUnlocking] = useState(false);

  const estimateId = session?.estimateId ?? null;

  // ── 3. Back does not leave ────────────────────────────────────────────────────
  useEffect(() => {
    window.history.pushState({ signing: true }, "");
    const onPop = () => window.history.pushState({ signing: true }, "");
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // ── 4. Idle drops to the PIN lock ─────────────────────────────────────────────
  useEffect(() => {
    if (phase === "locked") return;
    const tick = window.setInterval(() => {
      const s = readSigningSession();
      if (!s || Date.now() - s.lastActivity > IDLE_LIMIT_MS) setPhase("locked");
    }, 5000);
    const bump = () => touchSigningSession();
    for (const ev of ["pointerdown", "keydown", "touchstart"]) {
      window.addEventListener(ev, bump, { passive: true });
    }
    return () => {
      window.clearInterval(tick);
      for (const ev of ["pointerdown", "keydown", "touchstart"]) {
        window.removeEventListener(ev, bump);
      }
    };
  }, [phase]);

  // ── The estimate, rendered by the server ──────────────────────────────────────
  const load = useCallback(async () => {
    if (!estimateId) return;
    try {
      setHtml(await api.pbCustomerView(estimateId));
      setLoadError(null);
    } catch (err) {
      // A 403 here means the signing token expired or was scoped elsewhere — either way the
      // customer must not be shown the CRM, so this falls to the PIN lock.
      if ((err as ApiError).status === 403 || (err as ApiError).status === 401) {
        setPhase("locked");
        return;
      }
      setLoadError((err as Error).message);
    }
  }, [estimateId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!session || !estimateId) {
    // Defensive: App.tsx only renders this while a signing session exists.
    return null;
  }

  const submitSignature = async () => {
    setSignError(null);
    if (signerName.trim().length < 2) {
      setSignError("Please type your full name.");
      return;
    }
    if (!agreed) {
      setSignError("Please tick the box to agree before signing.");
      return;
    }
    setSigning(true);
    try {
      await api.pbSignInPerson(estimateId, signerName.trim());
      await load();
      setPhase("signed");
    } catch (err) {
      if ((err as ApiError).status === 403 || (err as ApiError).status === 401) {
        setPhase("locked");
        return;
      }
      setSignError((err as Error).message);
    } finally {
      setSigning(false);
    }
  };

  const exitWithPin = async () => {
    setPinError(null);
    setUnlocking(true);
    try {
      // The PIN mints a fresh FULL session — the only way back out of a signing scope.
      const res = await api.pinLogin(pin);
      localStorage.setItem("rce_token", res.token);
      clearSigningSession();
      window.location.replace("/estimate-intake");
    } catch {
      setPinError("Incorrect PIN.");
      setUnlocking(false);
    }
  };

  // ── The PIN lock ──────────────────────────────────────────────────────────────
  if (phase === "locked") {
    return (
      <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-rce-primary p-6 text-white">
        <h1 className="text-xl font-semibold">Red Cedar Electric</h1>
        <p className="mt-2 text-center text-sm opacity-90">
          This device is locked. Hand it back to your electrician.
        </p>
        <input
          className="mt-6 w-48 rounded-lg border-0 p-3 text-center text-2xl tracking-widest text-rce-text"
          type="password"
          inputMode="numeric"
          autoComplete="off"
          placeholder="PIN"
          value={pin}
          onChange={(e) => setPin(e.target.value)}
        />
        {pinError && <p className="mt-2 text-sm text-red-200">{pinError}</p>}
        <button
          className="mt-4 rounded-lg bg-white px-8 py-3 font-semibold text-rce-primary disabled:opacity-50"
          disabled={!pin || unlocking}
          onClick={() => void exitWithPin()}
        >
          {unlocking ? "Checking…" : "Unlock"}
        </button>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-rce-bg">
      <div className="flex items-center justify-between bg-rce-primary px-4 py-3 text-white">
        <span className="text-sm font-semibold">
          {phase === "signed" ? "Signed — thank you" : "Please review your estimate"}
        </span>
        {/* The only way out, and it asks for the PIN. Labelled for the customer, not the operator. */}
        <button
          className="rounded border border-white/40 px-3 py-1 text-xs"
          onClick={() => setPhase("locked")}
        >
          Done
        </button>
      </div>

      {loadError && (
        <p className="m-4 rounded bg-red-50 p-3 text-sm text-red-900">{loadError}</p>
      )}

      {/* The SERVER's render — identical to the emailed page. Sandboxed: the iframe may lay
          itself out and nothing else. No scripts, no navigation, no access to this origin. */}
      <iframe
        title="Your estimate"
        className="min-h-0 flex-1 border-0 bg-white"
        sandbox=""
        srcDoc={html ?? "<p style='font-family:sans-serif;padding:24px;'>Loading your estimate…</p>"}
      />

      {phase === "reviewing" && (
        <div className="border-t border-rce-border bg-white p-4">
          <label className="block text-sm font-semibold text-rce-text">
            Type your full name to sign
            <input
              className="field mt-1 w-full text-base"
              value={signerName}
              onChange={(e) => setSignerName(e.target.value)}
              autoComplete="name"
              placeholder="Your full name"
            />
          </label>
          <label className="mt-3 flex items-start gap-2 text-xs text-rce-soft">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={agreed}
              onChange={(e) => setAgreed(e.target.checked)}
            />
            <span>
              I agree to the scope and the price on this estimate, and I authorize Red Cedar
              Electric LLC to perform the work described. I understand this is an electronic
              signature with the same effect as a written one.
            </span>
          </label>
          {signError && (
            <p className="mt-2 rounded bg-red-50 p-2 text-xs text-red-900">{signError}</p>
          )}
          <button
            className="btn btn-primary mt-3 w-full py-3 text-base"
            disabled={signing}
            onClick={() => void submitSignature()}
          >
            {signing ? "Signing…" : "Accept & Sign"}
          </button>
        </div>
      )}

      {phase === "signed" && (
        <div className="border-t border-rce-border bg-white p-4 text-center">
          <p className="text-sm text-rce-text">
            <strong>Thank you.</strong> Your signature has been recorded and a copy has gone to
            Red Cedar Electric.
          </p>
          <button className="btn btn-primary mt-3 w-full py-3" onClick={() => setPhase("locked")}>
            Hand back to your electrician
          </button>
        </div>
      )}
    </div>
  );
}
