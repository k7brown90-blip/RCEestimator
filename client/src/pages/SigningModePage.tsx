/**
 * In-person signing — the customer reads the estimate and signs on the operator's device.
 *
 * Kyle's ruling: *"I want them to be able to view the quote in app and sign there as the first
 * option."*
 *
 * ── THE DEVICE LOCK WAS REMOVED, 2026-08-18, ON KYLE'S INSTRUCTION ────────────────────────────
 *
 * P028 wrapped this screen in a lock: the session was narrowed to one estimate on the server, the
 * router was short-circuited, the back button was trapped, an idle timer fired after five minutes,
 * and getting back into the CRM required the operator PIN.
 *
 * That design was AI-derived and recorded as *"stated for veto"* in
 * `decisions/2026-08-17-estimate-send-and-sign.md`. Kyle vetoed it:
 *
 *   *"I am not blocked on the pin screen, I don't like the feature and want it gone. It's not
 *    needed."*
 *
 * So the whole mechanism is gone — the scoped token, the PIN exit, the idle timeout, the history
 * trap. What is lost is worth stating once: a customer holding the phone can now navigate the CRM
 * if they choose to. Kyle hands his own phone to his own customers and judged that risk not worth
 * the friction, which is his call to make.
 *
 * What remains is the part that was always the point: the customer reads the SAME server-rendered
 * estimate the emailed link serves, and signs it, and the signature is recorded identically apart
 * from `signedChannel: "in_person"`.
 */

import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import { SignaturePad } from "../components/SignaturePad";

type Phase = "reviewing" | "signed";

export function SigningModePage() {
  const { estimateId = "" } = useParams();
  const navigate = useNavigate();
  const [phase, setPhase] = useState<Phase>("reviewing");
  const [html, setHtml] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [signerName, setSignerName] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [signature, setSignature] = useState<string | null>(null);
  const [signError, setSignError] = useState<string | null>(null);
  const [signing, setSigning] = useState(false);

  const load = useCallback(async () => {
    if (!estimateId) return;
    try {
      setHtml(await api.pbCustomerView(estimateId));
      setLoadError(null);
    } catch (err) {
      setLoadError((err as ApiError).message);
    }
  }, [estimateId]);

  useEffect(() => {
    void load();
  }, [load]);

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
    if (!signature) {
      setSignError("Please draw your signature in the box.");
      return;
    }
    setSigning(true);
    try {
      await api.pbSignInPerson(estimateId, signerName.trim(), signature);
      await load();
      setPhase("signed");
    } catch (err) {
      setSignError((err as Error).message);
    } finally {
      setSigning(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-rce-bg">
      <div className="flex items-center justify-between bg-rce-primary px-4 py-3 text-white">
        <span className="text-sm font-semibold">
          {phase === "signed" ? "Signed — thank you" : "Please review your estimate"}
        </span>
        <button
          className="rounded border border-white/40 px-3 py-1 text-xs"
          onClick={() => navigate(-1)}
        >
          Close
        </button>
      </div>

      {loadError && <p className="m-4 rounded bg-red-50 p-3 text-sm text-red-900">{loadError}</p>}

      {/* The SERVER's render — identical to the emailed page, so the no-prices and no-hours rules
          are held in one place for both channels. Sandboxed: layout only, no scripts, no
          navigation, no access to this origin. */}
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
          <div className="mt-3">
            <SignaturePad onChange={setSignature} disabled={signing} />
          </div>

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
          <button className="btn btn-primary mt-3 w-full py-3" onClick={() => navigate(-1)}>
            Done
          </button>
        </div>
      )}
    </div>
  );
}
