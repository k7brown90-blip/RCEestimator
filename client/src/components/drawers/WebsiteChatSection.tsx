/**
 * The "Website chat" section of the lead drawer (plan 2026-10-30-website-booking-chat, U3).
 *
 * A homeowner who used the chat on the website leaves a lead with a held time on the calendar
 * (decision A: the bot HOLDS, the office CONFIRMS). This is where the office sees everything the
 * homeowner said and showed, and where it acts on the hold — the exit lives where the thing is
 * shown (CLAUDE.md, "nothing the app creates is permanent"):
 *
 *   Confirm booking — convert the lead, schedule the held time, email the customer, put the photos
 *                     on the job. One button; the drawer owns the mutation because the duplicate-
 *                     account question reuses the drawer's picker.
 *   Release hold    — drop the held slot from the calendar and keep the lead.
 *   Delete photo    — on each thumbnail.
 *
 * Words are the ones Kyle would say out loud. Customer text is shown as written, never edited.
 */

import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import type { Lead, LeadBookingChat, LeadPhotoMeta } from "../../lib/types";

const STATUS_WORDS: Record<LeadBookingChat["status"], { label: string; tone: string }> = {
  open: { label: "Chat in progress", tone: "bg-zinc-200 text-zinc-700" },
  unbooked: { label: "No time held — call this customer back", tone: "bg-amber-100 text-amber-800" },
  held: { label: "Time held — waiting for you to confirm", tone: "bg-rce-accentBg text-rce-warning" },
  confirmed: { label: "Booking confirmed", tone: "bg-green-100 text-rce-success" },
  released: { label: "Hold released", tone: "bg-zinc-200 text-zinc-700" },
  out_of_scope: { label: "Outside what we schedule — pass to Kyle", tone: "bg-red-100 text-red-700" },
};

/** One thumbnail. The bytes sit behind the session, so they are fetched with it and shown as an object URL. */
function PhotoThumb({
  leadId, photo, onDelete, deleting,
}: { leadId: string; photo: LeadPhotoMeta; onDelete: () => void; deleting: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let gone = false;
    let made: string | null = null;
    api.leadPhotoUrl(leadId, photo.id)
      .then((next) => {
        if (gone) { try { URL.revokeObjectURL(next); } catch { /* not every environment has it */ } return; }
        made = next;
        setUrl(next);
      })
      .catch(() => setFailed(true));
    return () => {
      gone = true;
      if (made) { try { URL.revokeObjectURL(made); } catch { /* ignore */ } }
    };
  }, [leadId, photo.id]);

  const what = photo.kind === "panel" ? "Electrical panel photo" : `Photo${photo.room ? ` — ${photo.room}` : ""}`;
  return (
    <figure className="w-28 space-y-1">
      {failed ? (
        <div className="flex h-24 w-28 items-center justify-center rounded border border-rce-border bg-rce-border/30 px-1 text-center text-[10px] text-rce-soft">
          Can't preview this photo here
        </div>
      ) : !url ? (
        <div className="h-24 w-28 animate-pulse rounded bg-rce-border/40" aria-label={`Loading ${what}`} />
      ) : (
        <a href={url} target="_blank" rel="noreferrer" title="Open full size">
          <img src={url} alt={what} className="h-24 w-28 rounded border border-rce-border object-cover" />
        </a>
      )}
      <button
        type="button"
        className="text-[11px] text-red-700 underline disabled:opacity-50"
        disabled={deleting}
        onClick={() => { if (window.confirm(`Delete this photo? The customer's other photos and their written notes stay.`)) onDelete(); }}
        aria-label={`Delete photo: ${what}`}
      >
        {deleting ? "Deleting…" : "Delete photo"}
      </button>
    </figure>
  );
}

const roleWords: Record<string, string> = {
  user: "Customer", assistant: "Assistant", note: "Note", tool: "System", event: "Event",
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-rce-soft">{label}</p>
      <div className="mt-0.5 whitespace-pre-wrap">{children}</div>
    </div>
  );
}

export function WebsiteChatSection({
  lead, chat, photos, onConfirm, confirming, onRelease, releasing, onDeletePhoto, deletingPhotoId,
}: {
  lead: Lead;
  chat: LeadBookingChat;
  photos: LeadPhotoMeta[];
  onConfirm: () => void;
  confirming: boolean;
  onRelease: () => void;
  releasing: boolean;
  onDeletePhoto: (photoId: string) => void;
  deletingPhotoId: string | null;
}) {
  const held = chat.status === "held";
  const status = STATUS_WORDS[chat.status] ?? STATUS_WORDS.open;
  const byId = new Map(photos.map((p) => [p.id, p]));
  const panel = photos.filter((p) => p.kind === "panel");
  const referenced = new Set(chat.concerns.map((c) => c.photoId).filter((id): id is string => Boolean(id)));
  const loose = photos.filter((p) => p.kind !== "panel" && !referenced.has(p.id));

  const thumb = (p: LeadPhotoMeta) => (
    <PhotoThumb key={p.id} leadId={lead.id} photo={p} deleting={deletingPhotoId === p.id} onDelete={() => onDeletePhoto(p.id)} />
  );

  return (
    <section aria-label="Website chat" className="space-y-3 rounded-lg border border-rce-border p-3">
      <h3 className="text-sm font-semibold">Website chat</h3>

      {/* ── Status + the held slot, first and large ── */}
      <div className="space-y-2">
        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${status.tone}`}>{status.label}</span>
        {(held || chat.status === "confirmed") && chat.heldLabel && (
          <p className="text-base font-semibold">
            {chat.status === "confirmed" ? "Booked: " : "Held: "}{chat.heldLabel}
          </p>
        )}
        {held && (
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn btn-primary text-xs" disabled={confirming || releasing}
              onClick={() => { if (window.confirm(`Confirm ${chat.heldLabel ?? "this time"} for ${lead.name}? This converts the lead into an account, address and job, books that time, and emails the customer their confirmation.`)) onConfirm(); }}
              title="Converts this lead into an account, address and job, books the held time, emails the customer, and puts their photos on the job">
              {confirming ? "Confirming…" : "Confirm booking"}
            </button>
            <button type="button" className="btn btn-secondary text-xs" disabled={confirming || releasing}
              onClick={() => { if (window.confirm(`Release the held time (${chat.heldLabel ?? "this slot"})? It comes off the calendar and ${lead.name} stays a lead. Nothing is sent to the customer.`)) onRelease(); }}>
              {releasing ? "Releasing…" : "Release hold"}
            </button>
          </div>
        )}
        {held && (
          <p className="text-xs text-rce-muted">
            Confirm booking emails {lead.name} their appointment and a reminder to clear access to the panel and attic. Release hold frees the time and sends nothing.
          </p>
        )}
      </div>

      {/* ── Priority, in the customer's own words ── */}
      {chat.priority && (
        <div role="alert" className="rounded border-2 border-red-600 bg-red-50 px-3 py-2 text-red-800">
          <p className="text-xs font-bold uppercase tracking-wide">Priority</p>
          <p className="text-sm font-medium">
            {chat.priorityQuote ? <>“{chat.priorityQuote}”</> : "The customer described a priority condition."}
          </p>
        </div>
      )}

      <div className="space-y-3 text-sm">
        <Row label="Original request">{chat.originalRequest ?? <span className="text-rce-muted">not given</span>}</Row>

        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-rce-soft">Concerns ({chat.concerns.length})</p>
          {chat.concerns.length === 0 && loose.length === 0 ? (
            <p className="mt-0.5 text-rce-muted">none listed</p>
          ) : (
            <ul className="mt-1 space-y-2">
              {chat.concerns.map((c, i) => {
                const photo = c.photoId ? byId.get(c.photoId) : undefined;
                return (
                  <li key={`${c.room}-${i}`} className="flex flex-wrap items-start gap-3">
                    {photo && thumb(photo)}
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">{c.room || "Room not given"}</p>
                      <p className="whitespace-pre-wrap text-rce-muted">{c.description}</p>
                      {!photo && <p className="text-xs text-rce-soft">no photo</p>}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {loose.length > 0 && (
            <div className="mt-2">
              <p className="text-xs text-rce-muted">Other photos from the chat</p>
              <div className="mt-1 flex flex-wrap gap-3">{loose.map(thumb)}</div>
            </div>
          )}
        </div>

        <div className="flex flex-wrap gap-x-8 gap-y-2">
          <Row label="Square footage">{chat.squareFootage ?? <span className="text-rce-muted">not given</span>}</Row>
          <Row label="Year built">{chat.yearBuilt ?? <span className="text-rce-muted">not given</span>}</Row>
        </div>

        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-rce-soft">Panel photo</p>
          {panel.length === 0 ? (
            <p className="mt-0.5 text-rce-muted">not provided</p>
          ) : (
            <div className="mt-1 flex flex-wrap gap-3">{panel.map(thumb)}</div>
          )}
        </div>

        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-rce-soft">Questions for Kyle</p>
          {chat.questionsForKyle.length === 0 ? (
            <p className="mt-0.5 text-rce-muted">none</p>
          ) : (
            <ul className="mt-0.5 list-disc space-y-0.5 pl-5">
              {chat.questionsForKyle.map((q, i) => <li key={i} className="whitespace-pre-wrap">{q}</li>)}
            </ul>
          )}
        </div>

        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-rce-soft">Prep areas (in the customer's reminder)</p>
          {chat.prepAreas.length === 0 ? (
            <p className="mt-0.5 text-rce-muted">none named</p>
          ) : (
            <p className="mt-0.5">{chat.prepAreas.join(" · ")}</p>
          )}
        </div>

        <details className="rounded border border-rce-border/60 px-2 py-1">
          <summary className="cursor-pointer text-xs font-medium">Transcript ({chat.transcript.length} entries) — show</summary>
          <ol className="mt-2 space-y-1.5 text-xs">
            {chat.transcript.map((t, i) => (
              <li key={i} className={t.role === "user" ? "" : "text-rce-muted"}>
                <span className="font-semibold">{roleWords[t.role] ?? t.role}:</span>{" "}
                <span className="whitespace-pre-wrap">{t.content}</span>
              </li>
            ))}
          </ol>
        </details>
      </div>
    </section>
  );
}
