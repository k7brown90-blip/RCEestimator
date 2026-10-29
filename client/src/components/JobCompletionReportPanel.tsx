/**
 * "Job Completion Report" - the office's door onto the per-line write-up (Kyle, 2026-10-29).
 *
 * Kyle: "I need a receipt that I can send to the customer that I can attach reports and photos too
 * ... for the customers realtor so they can close out their home inspection punch list." and "Each
 * separate line item can get photos and an explination of what was done and why. It will follow our
 * same standard as the electrical assesment report so everyone gets the code compliance and
 * empirical data that is specific to our brand."
 *
 * One row per line of the job's signed invoice (the root and every signed change order, selected
 * options only): "What was done and why", NEC articles (the price-book item's article is the
 * starting point, editable), readings (label / value / unit), and photos from THIS job. The
 * technician writes the same rows in the field app - one record, two doors (server:
 * services/jobCompletion.ts; contract: shared/jobCompletion.ts). "Preview report" opens the PDF a
 * third party will get, so the office sees it before it goes out with the receipt.
 *
 * Standing rule (2026-09-18): every write-up has its way out right on the row - Save replaces it,
 * Clear takes the line off the report, each article, reading and photo has its own ×.
 *
 * Click path from the Dashboard: Jobs -> the job (drawer, or "Open full page") -> "Job Completion
 * Report" -> "Write up this line" -> Save -> "Preview report". Then the Take payment card ->
 * "Email the customer" -> Receipt -> tick the Job Completion Report.
 *
 * Photos: the job's own photos only (the server refuses any other visit's). They are listed and
 * uploaded through the SAME calls the Job Photos gallery uses - no second uploader.
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, openProtectedPdf } from "../lib/api";
import type { CompletionLineView } from "../lib/api";
import { shortDate } from "../lib/utils";
import { downscale } from "../lib/images";
import { AuthedPhoto, visitPhotosQuery } from "./PhotoGalleryPanel";
import {
  MAX_COMPLETION_PHOTOS,
  MAX_EXPLANATION_LENGTH,
  MAX_NEC_REF_LENGTH,
  MAX_NEC_REFS,
  MAX_READING_LABEL_LENGTH,
  MAX_READING_UNIT_LENGTH,
  MAX_READING_VALUE_LENGTH,
  MAX_READINGS,
  NO_LINES_WRITTEN_UP,
} from "../../../shared/jobCompletionLimits";

const EMPTY_SAVE = "Write what was done and why, add a reading or add a photo - or use Clear to take this line off the report.";
const photoPath = (id: string) => `/health-record-admin/visit-photos/${id}`;

interface ReadingDraft { label: string; value: string; unit: string }

/** One invoice line's write-up. Keyed by the parent on the saved timestamp, so a save re-seeds it from the server. */
function CompletionLineRow({ jobId, line, onChanged }: { jobId: string; line: CompletionLineView; onChanged: () => void }) {
  const queryClient = useQueryClient();
  const entry = line.entry;
  const [open, setOpen] = useState(false);
  const [explanation, setExplanation] = useState(entry?.explanation ?? "");
  const [necRefs, setNecRefs] = useState<string[]>(entry?.necRefs ?? line.defaultNecRefs);
  const [necTyped, setNecTyped] = useState("");
  const [readings, setReadings] = useState<ReadingDraft[]>(entry?.readings.map((r) => ({ label: r.label, value: r.value, unit: r.unit })) ?? []);
  const [photoIds, setPhotoIds] = useState<string[]>(entry?.photoIds ?? []);
  const [picking, setPicking] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: jobPhotos = [] } = useQuery({ ...visitPhotosQuery(jobId), enabled: open });

  // What actually goes: a reading row left completely blank is dropped; a half-filled one is the server's to refuse, in words.
  const cleanReadings = readings
    .map((r) => ({ label: r.label.trim(), value: r.value.trim(), unit: r.unit.trim() }))
    .filter((r) => r.label || r.value || r.unit);
  const hasContent = explanation.trim().length > 0 || cleanReadings.length > 0 || photoIds.length > 0;

  const save = useMutation({
    mutationFn: () =>
      api.saveJobCompletionLine(jobId, line.lineId, { explanation: explanation.trim(), necRefs, readings: cleanReadings, photoIds }),
    onSuccess: () => { setError(null); setOpen(false); onChanged(); },
    onError: (err) => setError((err as Error).message),
  });
  const clear = useMutation({
    mutationFn: () => api.clearJobCompletionLine(jobId, line.lineId),
    onSuccess: () => {
      setError(null);
      setExplanation("");
      setNecRefs(line.defaultNecRefs);
      setReadings([]);
      setPhotoIds([]);
      onChanged();
    },
    onError: (err) => setError((err as Error).message),
  });

  const addNec = () => {
    const ref = necTyped.trim();
    if (!ref) return;
    if (!necRefs.includes(ref)) setNecRefs([...necRefs, ref]);
    setNecTyped("");
  };
  const setReading = (i: number, patch: Partial<ReadingDraft>) =>
    setReadings(readings.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const addPhoto = (id: string) => {
    if (!photoIds.includes(id) && photoIds.length < MAX_COMPLETION_PHOTOS) setPhotoIds([...photoIds, id]);
  };

  // Upload through the gallery's own calls, then put the new photo straight onto this line.
  async function onUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length === 0) return;
    setUploading(true);
    setError(null);
    try {
      const added: string[] = [];
      for (const file of files) {
        const dataUrl = await downscale(file);
        const photo = await api.uploadVisitPhoto(jobId, { dataUrl, tag: null });
        added.push(photo.id);
      }
      setPhotoIds((cur) => [...cur, ...added.filter((id) => !cur.includes(id))].slice(0, MAX_COMPLETION_PHOTOS));
      void queryClient.invalidateQueries({ queryKey: ["visit-photos", jobId] });
      void queryClient.invalidateQueries({ queryKey: ["property-photos"] });
    } catch (ex) {
      setError((ex as Error).message);
    } finally {
      setUploading(false);
    }
  }

  const full = photoIds.length >= MAX_COMPLETION_PHOTOS;
  const pickable = jobPhotos.filter((p) => !photoIds.includes(p.id));
  const heading = line.documentKind === "change_order" ? `${line.name} — change order ${line.documentNumber}` : line.name;

  return (
    <li className="rounded-lg border border-rce-border p-3" aria-label={heading}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-semibold">{heading}</p>
          <p className="text-xs text-rce-muted">
            {entry
              ? `Written up${entry.updatedBy ? ` by ${entry.updatedBy}` : ""} on ${shortDate(entry.updatedAt)} — ${entry.photoIds.length} photo${entry.photoIds.length === 1 ? "" : "s"}, ${entry.readings.length} reading${entry.readings.length === 1 ? "" : "s"}`
              : "Not written up yet"}
          </p>
        </div>
        <button type="button" className="btn btn-secondary px-3 py-1 text-xs min-h-0" onClick={() => setOpen((o) => !o)}>
          {open ? "Close" : entry ? "Edit write-up" : "Write up this line"}
        </button>
      </div>

      {open && (
        <div className="mt-3 space-y-3">
          <label className="block text-xs font-medium text-rce-soft">
            What was done and why
            <textarea
              className="field mt-1"
              rows={4}
              maxLength={MAX_EXPLANATION_LENGTH}
              value={explanation}
              onChange={(e) => setExplanation(e.target.value)}
            />
          </label>

          <div>
            <p className="text-xs font-medium text-rce-soft">NEC articles</p>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              {necRefs.length === 0 && <span className="text-xs text-rce-soft">None cited on this line.</span>}
              {necRefs.map((ref) => (
                <span key={ref} className="inline-flex items-center gap-1 rounded-full border border-rce-border bg-white px-2 py-0.5 text-xs">
                  NEC {ref}
                  <button
                    type="button"
                    className="text-rce-muted hover:text-rce-danger"
                    aria-label={`Remove NEC article ${ref}`}
                    onClick={() => setNecRefs(necRefs.filter((r) => r !== ref))}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <input
                className="field text-xs"
                style={{ maxWidth: "12rem" }}
                placeholder="e.g. 210.8(A)"
                aria-label="NEC article"
                maxLength={MAX_NEC_REF_LENGTH}
                value={necTyped}
                onChange={(e) => setNecTyped(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addNec(); } }}
              />
              <button
                type="button"
                className="btn btn-secondary px-3 py-1 text-xs min-h-0"
                disabled={!necTyped.trim() || (necRefs.length >= MAX_NEC_REFS && !necRefs.includes(necTyped.trim()))}
                title={necRefs.length >= MAX_NEC_REFS ? `At most ${MAX_NEC_REFS} NEC articles on one line` : undefined}
                onClick={addNec}
              >
                Add article
              </button>
            </div>
          </div>

          <div>
            <p className="text-xs font-medium text-rce-soft">Readings</p>
            {readings.length === 0 && <p className="text-xs text-rce-soft">No readings on this line.</p>}
            <div className="mt-1 space-y-1.5">
              {readings.map((r, i) => (
                <div key={i} className="flex flex-wrap items-center gap-1.5">
                  <input className="field text-xs" style={{ maxWidth: "14rem" }} placeholder="Voltage L1–L2" aria-label={`Reading ${i + 1} label`} maxLength={MAX_READING_LABEL_LENGTH} value={r.label} onChange={(e) => setReading(i, { label: e.target.value })} />
                  <input className="field text-xs" style={{ maxWidth: "7rem" }} placeholder="240" aria-label={`Reading ${i + 1} value`} maxLength={MAX_READING_VALUE_LENGTH} value={r.value} onChange={(e) => setReading(i, { value: e.target.value })} />
                  <input className="field text-xs" style={{ maxWidth: "5rem" }} placeholder="V" aria-label={`Reading ${i + 1} unit`} maxLength={MAX_READING_UNIT_LENGTH} value={r.unit} onChange={(e) => setReading(i, { unit: e.target.value })} />
                  <button type="button" className="text-xs text-rce-muted underline" aria-label={`Remove reading ${i + 1}`} onClick={() => setReadings(readings.filter((_, idx) => idx !== i))}>
                    ×
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              className="btn btn-secondary mt-1 px-3 py-1 text-xs min-h-0"
              disabled={readings.length >= MAX_READINGS}
              title={readings.length >= MAX_READINGS ? `At most ${MAX_READINGS} readings on one line` : undefined}
              onClick={() => setReadings([...readings, { label: "", value: "", unit: "" }])}
            >
              Add reading
            </button>
          </div>

          <div>
            <p className="text-xs font-medium text-rce-soft">
              Photos ({photoIds.length} of {MAX_COMPLETION_PHOTOS}) — from this job
            </p>
            {photoIds.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-2">
                {photoIds.map((id) => (
                  <div key={id} className="relative">
                    <AuthedPhoto path={photoPath(id)} alt="photo on this line" className="h-16 w-16 rounded object-cover" />
                    <button
                      type="button"
                      className="absolute -right-1.5 -top-1.5 rounded-full bg-white px-1.5 text-xs shadow ring-1 ring-rce-border"
                      aria-label="Remove photo from this line"
                      onClick={() => setPhotoIds(photoIds.filter((x) => x !== id))}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="btn btn-secondary px-3 py-1 text-xs min-h-0"
                disabled={full}
                title={full ? `At most ${MAX_COMPLETION_PHOTOS} photos on one line` : undefined}
                onClick={() => setPicking((p) => !p)}
              >
                {picking ? "Done picking" : "Pick photos from this job"}
              </button>
              <label className={`btn btn-secondary px-3 py-1 text-xs min-h-0 ${full || uploading ? "opacity-60" : "cursor-pointer"}`} title={full ? `At most ${MAX_COMPLETION_PHOTOS} photos on one line` : undefined}>
                {uploading ? "Uploading…" : "Upload a photo"}
                <input type="file" accept="image/*" multiple hidden disabled={full || uploading} onChange={(e) => void onUpload(e)} />
              </label>
            </div>
            {picking && (
              pickable.length === 0 ? (
                <p className="mt-1 text-xs text-rce-soft">
                  {jobPhotos.length === 0 ? "No photos on this job yet. Upload one, or photos taken in the field app will appear here." : "Every photo on this job is already on this line."}
                </p>
              ) : (
                <div className="mt-1 grid max-h-44 grid-cols-4 gap-1.5 overflow-y-auto sm:grid-cols-6">
                  {pickable.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      className="overflow-hidden rounded border-2 border-transparent hover:border-rce-accent disabled:opacity-50"
                      disabled={full}
                      title={p.caption ?? "Add this photo to the line"}
                      aria-label={`Add photo${p.caption ? ` ${p.caption}` : ""} to this line`}
                      onClick={() => addPhoto(p.id)}
                    >
                      <AuthedPhoto path={photoPath(p.id)} alt={p.caption ?? "job photo"} className="h-16 w-full object-cover" />
                    </button>
                  ))}
                </div>
              )
            )}
          </div>

          {error && <p role="alert" className="rounded bg-red-50 px-2 py-1 text-xs text-red-800">{error}</p>}
          {!hasContent && <p className="text-[11px] text-rce-soft">{EMPTY_SAVE}</p>}

          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              className="btn btn-danger px-3 py-1 text-xs min-h-0"
              disabled={!entry || clear.isPending}
              title={!entry ? "Nothing is written up on this line yet." : undefined}
              onClick={() => {
                if (window.confirm(`Clear the write-up for "${line.name}"? Its explanation, readings and photo picks come off the report. The photos themselves stay on the job.`)) clear.mutate();
              }}
            >
              Clear
            </button>
            <button
              type="button"
              className="btn btn-primary px-3 py-1 text-xs min-h-0"
              disabled={!hasContent || save.isPending}
              title={!hasContent ? EMPTY_SAVE : undefined}
              onClick={() => save.mutate()}
            >
              {save.isPending ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

export function JobCompletionReportPanel({ jobId }: { jobId: string }) {
  const queryClient = useQueryClient();
  const { data, error } = useQuery({
    queryKey: ["job-completion-lines", jobId],
    queryFn: () => api.jobCompletionLines(jobId),
  });

  // A save or clear changes the receipt's "Attach reports" list too (it is on the payment-info response).
  const changed = () => {
    void queryClient.invalidateQueries({ queryKey: ["job-completion-lines", jobId] });
    void queryClient.invalidateQueries({ queryKey: ["paymentInfo"] });
  };

  const nothingWritten = !data || data.writtenUp === 0;

  return (
    <article className="card rounded-2xl border border-rce-border/70 p-5" aria-label="Job Completion Report">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Job Completion Report</h2>
          <p className="text-sm text-rce-muted">
            What was done and why on each invoice line, with the code articles, readings and photos — the
            proof of work a customer, realtor or inspector can be sent with the receipt.
            {data?.invoiceNumber ? ` Invoice ${data.invoiceNumber}.` : ""}
            {data && data.lines.length > 0 ? ` ${data.writtenUp} of ${data.lines.length} lines written up.` : ""}
          </p>
        </div>
        <div className="text-right">
          <button
            type="button"
            className="btn btn-secondary text-sm"
            disabled={nothingWritten}
            title={nothingWritten ? NO_LINES_WRITTEN_UP : undefined}
            onClick={() => void openProtectedPdf(api.jobCompletionReportUrl(jobId))}
          >
            Preview report
          </button>
          {nothingWritten && <p className="mt-0.5 text-[11px] text-rce-soft">{NO_LINES_WRITTEN_UP}</p>}
        </div>
      </div>

      {error && <p role="alert" className="mt-2 rounded bg-red-50 px-2 py-1 text-xs text-red-800">{(error as Error).message}</p>}
      {!data && !error && <p className="mt-3 text-sm text-rce-soft">Loading…</p>}
      {data && data.lines.length === 0 && (
        <p className="mt-3 text-sm text-rce-muted">{data.reason ?? "This job has no invoice lines to write up yet."}</p>
      )}
      {data && data.lines.length > 0 && (
        <ul className="mt-3 space-y-2">
          {data.lines.map((line) => (
            <CompletionLineRow
              key={`${line.lineId}:${line.entry?.updatedAt ?? "none"}`}
              jobId={jobId}
              line={line}
              onChanged={changed}
            />
          ))}
        </ul>
      )}
    </article>
  );
}
