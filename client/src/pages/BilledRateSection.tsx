/**
 * Settings -> "Billed labor rate" (Kyle, 2026-10-27).
 *
 * Kyle: "I want to be able to edit the chosen hourly rate in the app. This way we do not need to code
 * everytime we need to update." Then: "I want it to stay $100 for now. I just want the ability to edit
 * it so I can update the price book with our hourly rate when needed."
 *
 * The screen changes nothing on its own. Type a rate -> "Preview the change" (read-only: how many
 * price-book items will reprice, a few before/after examples, and any items it will NOT touch and why)
 * -> "Apply $X/hr to the price book" (confirmed, one transaction on the server). The way back is the
 * same box: type the old rate, preview, apply.
 *
 * Estimates already sent or signed keep the prices they were sent at - the server never writes them.
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { BilledRateApplied, BilledRatePreview, BilledRateTierChange } from "../lib/api";

const MAX_RATE = 1000;
const dollars = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `$${n.toFixed(2)}`);

/** Why a typed value cannot be used, or null. Mirrors the server (billedRateChange.billedRateProblem). */
function rateProblem(text: string): string | null {
  if (text.trim() === "") return "Type the new hourly rate first.";
  const n = Number(text);
  if (!Number.isFinite(n)) return "Enter the rate as a number, e.g. 100 or 112.50.";
  if (n <= 0) return "The billed rate must be more than $0.";
  if (n > MAX_RATE) return `The billed rate cannot be more than $${MAX_RATE.toLocaleString("en-US")} an hour.`;
  if (Math.abs(Math.round(n * 100) / 100 - n) > 1e-9) return "Use dollars and cents only (two decimal places at most).";
  return null;
}

const tierText = (label: string, c: BilledRateTierChange | null) => (c ? `${label} ${dollars(c.from)} → ${dollars(c.to)}` : null);

export function BilledRateSection() {
  const queryClient = useQueryClient();
  const { data: current, isLoading } = useQuery({ queryKey: ["billed-rate"], queryFn: api.billedRate });
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<BilledRatePreview | null>(null);
  const [applied, setApplied] = useState<BilledRateApplied | null>(null);
  const [error, setError] = useState<string | null>(null);

  const currentRate = current?.rate ?? null;
  const problem = rateProblem(text);
  const typed = problem ? null : Number(text);
  const sameAsCurrent = typed !== null && currentRate !== null && Math.abs(typed - currentRate) < 1e-9;
  const previewed = preview !== null && typed !== null && Math.abs(preview.newRate - typed) < 1e-9;

  const previewReason: string | null = problem ?? (sameAsCurrent ? `That is already the billed rate (${dollars(currentRate)}/hr).` : null);
  const applyReason: string | null = previewReason ?? (previewed ? null : 'Click "Preview the change" first, so you can see what will reprice.');

  const previewMutation = useMutation({
    mutationFn: (rate: number) => api.billedRatePreview(rate),
    onSuccess: (data) => { setPreview(data); setError(null); },
    onError: (e: Error) => { setPreview(null); setError(e.message); },
  });

  const applyMutation = useMutation({
    mutationFn: (rate: number) => api.billedRateApply(rate),
    onSuccess: (data) => {
      setApplied(data);
      setPreview(null);
      setText("");
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ["billed-rate"] });
    },
    onError: (e: Error) => setError(e.message),
  });

  const onType = (v: string) => {
    setText(v);
    setPreview(null); // a preview belongs to the exact rate that was typed
    setApplied(null);
    setError(null);
  };

  const onApply = () => {
    if (typed === null || !previewed) return;
    const ok = window.confirm(
      `Set the billed labor rate to ${dollars(typed)}/hr and re-price the price book?\n\n` +
        `${preview?.repriceCount ?? 0} price-book item(s) will change.\n` +
        `Estimates already sent or signed keep the prices they were sent at.\n` +
        `To undo, type the old rate (${dollars(currentRate)}) here and apply it.`,
    );
    if (ok) applyMutation.mutate(typed);
  };

  return (
    <section className="card mt-5 p-6" data-testid="billed-rate-card">
      <h2 className="text-lg font-semibold">Billed labor rate</h2>
      <p className="mt-1 text-sm text-rce-muted">
        The hourly rate every labor price in the price book is built from (price = hours × rate + material). Applying a new rate
        re-prices the price book and the estimates still being built. Estimates already sent or signed keep the prices they were sent at.
      </p>

      <div className="mt-4">
        <p className="text-sm">
          Current rate:{" "}
          <strong data-testid="billed-rate-current">
            {isLoading ? "loading…" : currentRate === null ? "not set" : `${dollars(currentRate)} / hr`}
          </strong>
        </p>
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <label className="text-sm font-medium">
          New hourly rate ($)
          <input
            className="field mt-1 w-full"
            type="number"
            step="0.01"
            min="0"
            inputMode="decimal"
            placeholder={currentRate === null ? "100" : String(currentRate)}
            value={text}
            onChange={(e) => onType(e.target.value)}
          />
        </label>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          className="btn btn-secondary"
          type="button"
          disabled={previewReason !== null || previewMutation.isPending}
          title={previewReason ?? undefined}
          onClick={() => typed !== null && previewMutation.mutate(typed)}
        >
          {previewMutation.isPending ? "Working it out…" : "Preview the change"}
        </button>
        <button
          className="btn btn-primary"
          type="button"
          disabled={applyReason !== null || applyMutation.isPending}
          title={applyReason ?? undefined}
          onClick={onApply}
        >
          {applyMutation.isPending ? "Applying…" : typed !== null ? `Apply ${dollars(typed)}/hr to the price book` : "Apply to the price book"}
        </button>
      </div>
      {applyReason && text.trim() !== "" && (
        <p className="mt-2 text-xs text-rce-muted" data-testid="billed-rate-reason">{applyReason}</p>
      )}

      {error && <p className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">{error}</p>}

      {preview && previewed && (
        <div className="mt-4 rounded-md border border-rce-border bg-white px-4 py-3 text-sm" data-testid="billed-rate-preview">
          <p className="font-semibold">
            At {dollars(preview.newRate)}/hr (now {preview.currentRate === null ? "not set" : dollars(preview.currentRate)}):{" "}
            {preview.repriceCount} price-book item{preview.repriceCount === 1 ? "" : "s"} will reprice
            {preview.assemblyCount > 0 ? ` (${preview.assemblyCount} of them assemblies)` : ""}.
          </p>
          <p className="mt-1 text-xs text-rce-muted">
            {preview.unchangedCount} priced item{preview.unchangedCount === 1 ? "" : "s"} need no change (material-only or no hours).{" "}
            {preview.openDrafts} estimate{preview.openDrafts === 1 ? "" : "s"} still being built will be re-stamped at the new rate.
            Sent and signed estimates are not touched.
          </p>

          {preview.samples.length > 0 && (
            <>
              <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-rce-muted">Examples (normal / difficult / very difficult)</p>
              <ul className="mt-1 space-y-1">
                {preview.samples.map((s) => (
                  <li key={s.itemId} className="text-xs">
                    <span className="font-medium">{s.itemId}</span>
                    {s.description ? ` — ${s.description}` : ""}:{" "}
                    {[tierText("normal", s.normal), tierText("difficult", s.difficult), tierText("very difficult", s.veryDifficult)]
                      .filter(Boolean)
                      .join("; ")}
                  </li>
                ))}
              </ul>
            </>
          )}

          {preview.convertedRows.length > 0 && (
            <p className="mt-3 text-xs text-rce-muted">
              Handled specially: {preview.convertedRows.filter((c) => c.kind === "PER-DOLLAR").length} per-dollar labor unit(s) stay $1.00 a unit
              {preview.convertedRows.some((c) => c.kind === "RATE-AS-MATERIAL")
                ? `; ${preview.convertedRows.filter((c) => c.kind === "RATE-AS-MATERIAL").length} old hourly-rate row(s) become labor-only`
                : ""}
              .
            </p>
          )}

          {preview.untouchedCount > 0 && (
            <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2" data-testid="billed-rate-untouched">
              <p className="text-xs font-semibold text-amber-900">
                {preview.untouchedCount} item{preview.untouchedCount === 1 ? "" : "s"} will NOT be changed. Their prices look hand-set, so they are left exactly as they are
                — edit them in the Price Book if they should move.
              </p>
              <ul className="mt-1 space-y-1">
                {preview.untouched.map((u) => (
                  <li key={u.itemId} className="text-xs text-amber-900">
                    <span className="font-medium">{u.itemId}</span>
                    {u.description ? ` — ${u.description}` : ""}: {u.why}
                  </li>
                ))}
              </ul>
              {preview.untouchedCount > preview.untouched.length && (
                <p className="mt-1 text-xs text-amber-900">…and {preview.untouchedCount - preview.untouched.length} more.</p>
              )}
            </div>
          )}
        </div>
      )}

      {applied && (
        <div className="mt-4 rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-900" data-testid="billed-rate-applied">
          <p className="font-semibold">
            Saved: the billed labor rate is now {dollars(applied.newRate)}/hr
            {applied.previousRate !== null ? ` (was ${dollars(applied.previousRate)})` : ""}.
          </p>
          <p className="mt-1 text-xs">
            {applied.rowsUpdated} price-book item{applied.rowsUpdated === 1 ? "" : "s"} re-priced; every change is in the price book's edit history.{" "}
            {applied.draftsResnapshotted} estimate{applied.draftsResnapshotted === 1 ? "" : "s"} still being built re-stamped.
          </p>
          {applied.untouchedCount > 0 && (
            <p className="mt-1 text-xs">
              {applied.untouchedCount} hand-priced item{applied.untouchedCount === 1 ? " was" : "s were"} left as they were:{" "}
              {applied.untouched.slice(0, 10).map((u) => u.itemId).join(", ")}
              {applied.untouchedCount > 10 ? ", …" : ""}.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
