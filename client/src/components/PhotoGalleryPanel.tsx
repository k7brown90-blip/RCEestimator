import { useEffect, useState } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, fetchProtectedObjectUrl } from "../lib/api";
import type { PhotoTag, VisitPhotoMeta } from "../lib/api";
import { downscale } from "../lib/images";
import { PhotoLightbox } from "./PhotoLightbox";
import type { AccountJob } from "../lib/types";

/**
 * The job photo gallery (Kyle, 2026-08-28) — replaced the legacy
 * Estimate/Proposal/AI tab section on the visit page.
 *
 * Photos taken on the job land here: before/after shots, assessment photos,
 * and anything worth keeping for the record. The "History at this address"
 * block pulls every photo ever taken at the property — job photos from other
 * visits and the Health Record assessment photos — so the historical reference
 * is one scroll away, read-only.
 *
 * Thumbnails fetch through the authed blob path — a bare <img src> carries no
 * Authorization header (same lesson the PDF buttons paid for). Photos attach
 * to estimate/invoice emails only through the explicit pickers in those send
 * flows; nothing here reaches a customer.
 */

const TAGS: Array<{ value: PhotoTag; label: string }> = [
  { value: "before", label: "Before" },
  { value: "after", label: "After" },
  { value: "assessment", label: "Assessment" },
  { value: "reference", label: "Reference" },
];

const tagLabel = (tag: PhotoTag | null) =>
  TAGS.find((t) => t.value === tag)?.label ?? "Untagged";

/**
 * The one definition of "fetch this property's photos" (tests/queryKeyCollisions.test.ts: a query
 * key names an ENDPOINT, and every caller of that endpoint shares this, rather than each writing
 * its own `{ queryKey, queryFn }` literal — four independent copies is how two of them drift and
 * the test (correctly) can no longer tell "same endpoint, different spelling" from "different
 * shape". Used by the visit gallery, the read-only history panel, the account-wide gallery
 * (useQueries, one per property — on the account page AND inside the estimate builder since
 * plan A, 2026-10-02), and the send-flow picker.
 */
function propertyPhotosQuery(propertyId: string) {
  return { queryKey: ["property-photos", propertyId] as const, queryFn: () => api.propertyPhotos(propertyId) };
}

/** Authed thumbnail with object-URL lifecycle handled. */
export function AuthedPhoto(props: { path: string; alt: string; className?: string; onClick?: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let dead = false;
    let objectUrl: string | null = null;
    void fetchProtectedObjectUrl(props.path)
      .then((u) => {
        objectUrl = u;
        if (!dead) setUrl(u);
      })
      .catch(() => {});
    return () => {
      dead = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [props.path]);
  if (!url) return <div className={`animate-pulse bg-rce-border/40 ${props.className ?? ""}`} />;
  return <img src={url} alt={props.alt} className={props.className} onClick={props.onClick} />;
}

function PhotoCard(props: { photo: VisitPhotoMeta; onChanged: () => void }) {
  const { photo, onChanged } = props;
  const [caption, setCaption] = useState(photo.caption ?? "");
  const [viewing, setViewing] = useState(false);

  const update = useMutation({
    mutationFn: (input: { caption?: string | null; tag?: PhotoTag | null }) =>
      api.updateVisitPhoto(photo.id, input),
    onSuccess: onChanged,
  });
  const remove = useMutation({
    mutationFn: () => api.deleteVisitPhoto(photo.id),
    onSuccess: onChanged,
  });

  return (
    <div className="overflow-hidden rounded-xl border border-rce-border bg-white shadow-sm">
      <AuthedPhoto
        path={`/health-record-admin/visit-photos/${photo.id}`}
        alt={photo.caption ?? "job photo"}
        className="h-40 w-full cursor-zoom-in object-cover"
        onClick={() => setViewing(true)}
      />
      <div className="space-y-1.5 p-2">
        <div className="flex items-center justify-between gap-2">
          <select
            className="rounded border border-rce-soft bg-white px-1.5 py-0.5 text-xs text-rce-muted"
            value={photo.tag ?? ""}
            onChange={(e) => update.mutate({ tag: (e.target.value || null) as PhotoTag | null })}
          >
            <option value="">Untagged</option>
            {TAGS.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
          <button
            type="button"
            className="btn btn-danger px-2 py-0.5 text-xs min-h-0"
            disabled={remove.isPending}
            onClick={() => {
              if (window.confirm("Delete this photo? This cannot be undone.")) remove.mutate();
            }}
          >
            Delete
          </button>
        </div>
        <input
          className="w-full rounded border border-rce-soft bg-white px-1.5 py-1 text-xs"
          placeholder="Caption…"
          value={caption}
          onChange={(e) => setCaption(e.target.value)}
          onBlur={() => {
            if ((photo.caption ?? "") !== caption.trim()) {
              update.mutate({ caption: caption.trim() || null });
            }
          }}
        />
      </div>
      {viewing && (
        <PhotoLightbox
          path={`/health-record-admin/visit-photos/${photo.id}`}
          alt={photo.caption ?? "job photo"}
          caption={photo.caption}
          onClose={() => setViewing(false)}
        />
      )}
    </div>
  );
}

export function PhotoGalleryPanel(props: { visitId: string; propertyId: string }) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [uploadTag, setUploadTag] = useState<PhotoTag | "">("");
  const [filter, setFilter] = useState<PhotoTag | "all">("all");
  const [showHistory, setShowHistory] = useState(false);
  // Zoomable viewer for the history thumbnails (Kyle, 2026-08-31).
  const [lightbox, setLightbox] = useState<{ path: string; alt: string; caption?: string | null } | null>(null);

  const { data: photos = [] } = useQuery({
    queryKey: ["visit-photos", props.visitId],
    queryFn: () => api.visitPhotos(props.visitId),
  });
  const { data: history } = useQuery({
    ...propertyPhotosQuery(props.propertyId),
    enabled: showHistory,
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["visit-photos", props.visitId] });
    void queryClient.invalidateQueries({ queryKey: ["property-photos", props.propertyId] });
  };

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length === 0) return;
    setBusy(true);
    setErr("");
    try {
      for (const file of files) {
        const dataUrl = await downscale(file);
        await api.uploadVisitPhoto(props.visitId, { dataUrl, tag: uploadTag || null });
      }
      refresh();
    } catch (ex) {
      setErr((ex as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const shown = filter === "all" ? photos : photos.filter((p) => p.tag === filter);
  // Other visits' photos only — this visit's are the main grid.
  const historyJobPhotos = (history?.jobPhotos ?? []).filter((p) => p.visitId !== props.visitId);
  const assessmentPhotos = history?.assessmentPhotos ?? [];

  return (
    <article className="card rounded-2xl border border-rce-border/70 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Job Photos</h2>
          <p className="text-sm text-rce-muted">
            Before &amp; after, assessment shots, and the record at this address. Attach them to the
            estimate or invoice email when you send it. Photos tagged{" "}
            <span className="font-medium">Assessment</span> are included in the Health Record report
            with their captions.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            className="rounded-lg border border-rce-soft bg-white px-2 py-1.5 text-xs text-rce-muted"
            value={uploadTag}
            onChange={(e) => setUploadTag(e.target.value as PhotoTag | "")}
            title="Tag applied to new uploads"
          >
            <option value="">Tag new photos…</option>
            {TAGS.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
          <label className="btn btn-primary cursor-pointer text-sm">
            {busy ? "Uploading…" : "+ Add photos"}
            <input
              type="file" accept="image/*" capture="environment" multiple hidden
              onChange={(e) => void onPick(e)} disabled={busy}
            />
          </label>
        </div>
      </div>
      {err && <p className="mt-2 text-xs text-rce-danger">{err}</p>}

      <div className="mt-3 flex flex-wrap gap-1.5">
        {([["all", `All (${photos.length})`] as const, ...TAGS.map((t) => [t.value, `${t.label} (${photos.filter((p) => p.tag === t.value).length})`] as const)]).map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={`rounded-full border px-2.5 py-1 text-xs font-medium ${
              filter === value
                ? "border-rce-accent bg-rce-accent text-rce-text"
                : "border-rce-border bg-white text-rce-muted hover:border-rce-accent/50"
            }`}
            onClick={() => setFilter(value as PhotoTag | "all")}
          >
            {label}
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <p className="mt-4 text-sm text-rce-soft">
          {photos.length === 0
            ? "No photos on this job yet. Photos synced from the field app appear here too."
            : "No photos with this tag."}
        </p>
      ) : (
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {shown.map((photo) => (
            <PhotoCard key={photo.id} photo={photo} onChanged={refresh} />
          ))}
        </div>
      )}

      <div className="mt-5 border-t border-rce-border/60 pt-3">
        <button
          type="button"
          className="btn btn-secondary px-3 py-1 text-sm min-h-0"
          onClick={() => setShowHistory((s) => !s)}
        >
          {showHistory ? "Hide history at this address" : "History at this address…"}
        </button>
        {showHistory && (
          <div className="mt-3 space-y-4">
            {historyJobPhotos.length === 0 && assessmentPhotos.length === 0 && (
              <p className="text-sm text-rce-soft">No photos from other visits or assessments at this address.</p>
            )}
            {historyJobPhotos.length > 0 && (
              <div>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-rce-soft">
                  Job photos from other visits
                </h3>
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6">
                  {historyJobPhotos.map((p) => (
                    <figure key={p.id}>
                      <AuthedPhoto
                        path={`/health-record-admin/visit-photos/${p.id}`}
                        alt={p.caption ?? "job photo"}
                        className="h-24 w-full cursor-zoom-in rounded object-cover"
                        onClick={() =>
                          setLightbox({
                            path: `/health-record-admin/visit-photos/${p.id}`,
                            alt: p.caption ?? "job photo",
                            caption: p.caption,
                          })
                        }
                      />
                      <figcaption className="mt-0.5 text-[10px] text-rce-soft">
                        {new Date(p.visitDate).toLocaleDateString()} · {tagLabel(p.tag)}
                        {p.caption ? ` · ${p.caption}` : ""}
                      </figcaption>
                    </figure>
                  ))}
                </div>
              </div>
            )}
            {assessmentPhotos.length > 0 && (
              <div>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-rce-soft">
                  Electrical assessment photos
                </h3>
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6">
                  {assessmentPhotos.map((p) => (
                    <figure key={p.id}>
                      <AuthedPhoto
                        path={`/health-record-admin/inspection-photos/${p.id}`}
                        alt="assessment photo"
                        className="h-24 w-full cursor-zoom-in rounded object-cover"
                        onClick={() =>
                          setLightbox({
                            path: `/health-record-admin/inspection-photos/${p.id}`,
                            alt: "assessment photo",
                          })
                        }
                      />
                      <figcaption className="mt-0.5 text-[10px] text-rce-soft">
                        {new Date(p.inspectionDate).toLocaleDateString()} · Health Record
                      </figcaption>
                    </figure>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
      {lightbox && (
        <PhotoLightbox
          path={lightbox.path}
          alt={lightbox.alt}
          caption={lightbox.caption}
          onClose={() => setLightbox(null)}
        />
      )}
    </article>
  );
}

/**
 * Read-only photo browser for an address: job photos across visits plus Health
 * Record assessment shots. Uploading and tagging stay on the visit page's
 * gallery, where the job context lives; each photo links back through its
 * visit.
 *
 * Originally built for the ACCOUNT page (Kyle, 2026-08-29: "I don't see where
 * to find the photos, I need to be able to access them"), superseded there by
 * `AccountPhotoGallery` (2026-10-01, which also uploads). Reused as-is on the
 * PROPERTY page's health record (plan item C, 2026-10-02: "Property photos
 * will also show up here as each photo will be assigned to a particular
 * property and consultation/diagnostics") — this page is read-only, so the
 * upload-capable version would be the wrong fit here.
 */
export function PropertyPhotoSection(props: { propertyId: string; propertyLabel: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(props.defaultOpen ?? false);
  // Zoomable viewer (Kyle, 2026-08-31) — nameplates are unreadable at thumbnail size.
  const [lightbox, setLightbox] = useState<{ path: string; alt: string; caption?: string | null } | null>(null);
  const { data: photos } = useQuery({
    ...propertyPhotosQuery(props.propertyId),
    enabled: open,
  });
  const jobPhotos = photos?.jobPhotos ?? [];
  const assessmentPhotos = photos?.assessmentPhotos ?? [];
  const total = jobPhotos.length + assessmentPhotos.length;

  return (
    <div className="rounded-lg border border-rce-border/70 p-3">
      <button
        type="button"
        className="flex w-full items-center justify-between text-left"
        onClick={() => setOpen((s) => !s)}
      >
        <span className="text-sm font-medium">{props.propertyLabel}</span>
        <span className="text-xs text-rce-accent">
          {open ? "Hide photos" : `View photos${total > 0 ? ` (${total})` : ""}`}
        </span>
      </button>
      {open && (
        <div className="mt-3 space-y-4">
          {jobPhotos.length === 0 && assessmentPhotos.length === 0 && (
            <p className="text-sm text-rce-soft">No photos at this address yet.</p>
          )}
          {jobPhotos.length > 0 && (
            <div>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-rce-soft">Job photos</h4>
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6">
                {jobPhotos.map((p) => (
                  <figure key={p.id}>
                    <AuthedPhoto
                      path={`/health-record-admin/visit-photos/${p.id}`}
                      alt={p.caption ?? "job photo"}
                      className="h-24 w-full cursor-zoom-in rounded object-cover"
                      onClick={() =>
                        setLightbox({
                          path: `/health-record-admin/visit-photos/${p.id}`,
                          alt: p.caption ?? "job photo",
                          caption: p.caption,
                        })
                      }
                    />
                    <figcaption className="mt-0.5 text-[10px] text-rce-soft">
                      {/* Which job the photo came from (Kyle, 2026-10-02: "each photo must show
                          which consultation or diagnostic it came from") — purpose is the visit's
                          reason (e.g. "Consultation — estimate visit"); jobType, when set, is more
                          specific and wins. */}
                      {p.jobType || p.purpose || "Job"} · {new Date(p.visitDate).toLocaleDateString()} · {tagLabel(p.tag)}
                      {p.caption ? ` · ${p.caption}` : ""}
                    </figcaption>
                  </figure>
                ))}
              </div>
            </div>
          )}
          {assessmentPhotos.length > 0 && (
            <div>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-rce-soft">
                Electrical assessment photos
              </h4>
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6">
                {assessmentPhotos.map((p) => (
                  <figure key={p.id}>
                    <AuthedPhoto
                      path={`/health-record-admin/inspection-photos/${p.id}`}
                      alt="assessment photo"
                      className="h-24 w-full cursor-zoom-in rounded object-cover"
                      onClick={() =>
                        setLightbox({
                          path: `/health-record-admin/inspection-photos/${p.id}`,
                          alt: "assessment photo",
                        })
                      }
                    />
                    <figcaption className="mt-0.5 text-[10px] text-rce-soft">
                      {new Date(p.inspectionDate).toLocaleDateString()} · Health Record
                    </figcaption>
                  </figure>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
      {lightbox && (
        <PhotoLightbox
          path={lightbox.path}
          alt={lightbox.alt}
          caption={lightbox.caption}
          onClose={() => setLightbox(null)}
        />
      )}
    </div>
  );
}

/**
 * ONE photo gallery for the whole account (Kyle, 2026-10-01: "I should be able
 * to upload photos on this screen here" / "the attached photos should prompt a
 * job selection but can all be viewed from a single place. I dont want to
 * click through different jobs to find a photo I am looking for.")
 *
 * Replaces the old read-only, per-property accordion on the account page.
 * Upload reuses the exact same endpoint the visit gallery uses
 * (`POST /health-record-admin/visits/:visitId/photos`) — a photo still belongs
 * to a visit, so uploading here asks which job it's for, same as the visit
 * gallery's "+ Add photos" just without first navigating to that visit.
 *
 * Assembled client-side: `api.propertyPhotos` is per-PROPERTY (there is no
 * per-account endpoint), so this fires one query per property the account has
 * — same `["property-photos", propertyId]` key and shape the visit gallery and
 * the send-flow picker already use, so uploads here invalidate everywhere else
 * automatically, and no new endpoint is needed.
 *
 * ALSO THE ESTIMATE BUILDER'S PHOTO PANEL (plan A, Kyle 2026-10-02: "Draft
 * photos don't make sense to me … we would obviously want the photos added to
 * the estimates that are from an applied job, consultation, or diagnostics").
 * The builder used to park its photos in a `DraftPhoto` table nothing else
 * could reach; now it renders THIS component for the estimate's account, so a
 * photo added while pricing is a job photo like any other, and it outlives the
 * estimate — when the 30 days pass and the estimate is rebuilt, the photos are
 * still on the consultation. `defaultVisitId` preselects the job the draft was
 * created from, when it has one. One upload path, not two.
 *
 * Every photo added here can be removed here (standing rule, Kyle 2026-09-18:
 * "nothing should be added that cannot be adjusted, edited, deleted"). The ×
 * on a job photo is the same `deleteVisitPhoto` the visit gallery uses, behind
 * the same confirm. Assessment photos belong to the Health Record and are not
 * created here, so they carry no ×.
 */
export function AccountPhotoGallery(props: {
  properties: Array<{ id: string; name: string; addressLine1: string; city: string }>;
  jobs: AccountJob[];
  /** The job to preselect for uploads — the consultation an estimate draft came from. */
  defaultVisitId?: string | null;
}) {
  const queryClient = useQueryClient();
  const [uploadVisitId, setUploadVisitId] = useState(props.defaultVisitId ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [lightbox, setLightbox] = useState<{ path: string; alt: string; caption?: string | null } | null>(null);
  const remove = useMutation({
    mutationFn: (input: { photoId: string; propertyId: string }) => api.deleteVisitPhoto(input.photoId),
    onSuccess: (_r, input) => void queryClient.invalidateQueries({ queryKey: ["property-photos", input.propertyId] }),
  });

  const propertyQueries = useQueries({
    queries: props.properties.map((property) => propertyPhotosQuery(property.id)),
  });

  const propertyLabel = (propertyId: string) => {
    const p = props.properties.find((candidate) => candidate.id === propertyId);
    return p ? `${p.name} — ${p.addressLine1}, ${p.city}` : "Address removed";
  };

  type CombinedPhoto = {
    key: string;
    path: string;
    alt: string;
    date: string;
    label: string;
    caption?: string | null;
    /** Set on job photos only — the id and property needed to delete it from here. */
    deletable?: { photoId: string; propertyId: string };
  };

  const combined: CombinedPhoto[] = [];
  props.properties.forEach((property, i) => {
    const data = propertyQueries[i]?.data;
    if (!data) return;
    for (const p of data.jobPhotos) {
      combined.push({
        key: `job-${p.id}`,
        path: `/health-record-admin/visit-photos/${p.id}`,
        alt: p.caption ?? "job photo",
        date: p.visitDate,
        label: `${p.jobType || p.purpose || "Job"} — ${propertyLabel(property.id)} · ${tagLabel(p.tag)}`,
        caption: p.caption,
        deletable: { photoId: p.id, propertyId: property.id },
      });
    }
    for (const p of data.assessmentPhotos) {
      combined.push({
        key: `assessment-${p.id}`,
        path: `/health-record-admin/inspection-photos/${p.id}`,
        alt: "assessment photo",
        date: p.inspectionDate,
        label: `Health Record assessment — ${propertyLabel(property.id)}`,
      });
    }
  });
  combined.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  // Newest first — the job someone just finished is the one they're most likely attaching
  // photos for.
  const sortedJobs = [...props.jobs].sort(
    (a, b) => new Date(b.visitDate).getTime() - new Date(a.visitDate).getTime(),
  );
  const jobLabel = (job: AccountJob) =>
    `${job.jobType || job.purpose || "Job"} — ${job.propertyLabel} (${new Date(job.visitDate).toLocaleDateString()})`;

  const onlyJob = sortedJobs.length === 1 ? sortedJobs[0] : null;
  // A preselected job that is not on this account (or was removed) counts as no choice — the
  // select must never claim a job that is not in its own list.
  const chosenVisitId = sortedJobs.some((j) => j.visitId === uploadVisitId) ? uploadVisitId : "";
  const effectiveVisitId = onlyJob ? onlyJob.visitId : chosenVisitId;

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length === 0 || !effectiveVisitId) return;
    setBusy(true);
    setErr("");
    try {
      for (const file of files) {
        const dataUrl = await downscale(file);
        await api.uploadVisitPhoto(effectiveVisitId, { dataUrl, tag: null });
      }
      const job = sortedJobs.find((j) => j.visitId === effectiveVisitId);
      if (job) void queryClient.invalidateQueries({ queryKey: ["property-photos", job.propertyId] });
    } catch (ex) {
      setErr((ex as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card mt-5 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Photos</h2>
          <p className="text-sm text-rce-muted">
            Every photo on record across this account's jobs and addresses, newest first.
          </p>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <div className="flex items-center gap-2">
            {sortedJobs.length > 1 && (
              <select
                className="field text-xs"
                aria-label="Which job are these photos for?"
                value={chosenVisitId}
                onChange={(e) => setUploadVisitId(e.target.value)}
              >
                <option value="">Which job are these photos for?</option>
                {sortedJobs.map((job) => (
                  <option key={job.visitId} value={job.visitId}>{jobLabel(job)}</option>
                ))}
              </select>
            )}
            <label
              className={`btn btn-primary text-sm ${
                sortedJobs.length === 0 || (sortedJobs.length > 1 && !chosenVisitId) || busy
                  ? "cursor-not-allowed opacity-50"
                  : "cursor-pointer"
              }`}
            >
              {busy ? "Uploading…" : "+ Add photos"}
              <input
                type="file" accept="image/*" capture="environment" multiple hidden
                onChange={(e) => void onPick(e)}
                disabled={sortedJobs.length === 0 || (sortedJobs.length > 1 && !chosenVisitId) || busy}
              />
            </label>
          </div>
          {sortedJobs.length === 0 && (
            <p className="text-xs text-rce-soft">
              No jobs on this account yet — create a job before adding photos.
            </p>
          )}
          {onlyJob && (
            <p className="text-xs text-rce-soft">Adding to: {jobLabel(onlyJob)}</p>
          )}
        </div>
      </div>
      {err && <p className="mt-2 text-xs text-rce-danger">{err}</p>}

      {combined.length === 0 ? (
        <p className="mt-4 text-sm text-rce-soft">No photos on this account yet.</p>
      ) : (
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {combined.map((photo) => (
            <figure key={photo.key} className="relative overflow-hidden rounded-xl border border-rce-border bg-white shadow-sm">
              <AuthedPhoto
                path={photo.path}
                alt={photo.alt}
                className="h-32 w-full cursor-zoom-in object-cover"
                onClick={() => setLightbox({ path: photo.path, alt: photo.alt, caption: photo.caption })}
              />
              {photo.deletable && (
                <button
                  type="button"
                  aria-label="Delete photo"
                  title="Delete this photo"
                  className="absolute right-1 top-1 rounded bg-black/60 px-1.5 text-xs text-white"
                  disabled={remove.isPending}
                  onClick={() => {
                    if (window.confirm("Delete this photo? This cannot be undone.")) remove.mutate(photo.deletable!);
                  }}
                >
                  ×
                </button>
              )}
              <figcaption className="space-y-0.5 p-2 text-[11px] text-rce-soft">
                <div>{new Date(photo.date).toLocaleDateString()}</div>
                <div className="truncate" title={photo.label}>{photo.label}</div>
                {photo.caption && <div className="truncate text-rce-muted" title={photo.caption}>{photo.caption}</div>}
              </figcaption>
            </figure>
          ))}
        </div>
      )}
      {lightbox && (
        <PhotoLightbox
          path={lightbox.path}
          alt={lightbox.alt}
          caption={lightbox.caption}
          onClose={() => setLightbox(null)}
        />
      )}
    </section>
  );
}

/**
 * Compact photo picker for the estimate/invoice send flows — tick the photos to ride the email.
 *
 * ── ANY PHOTO ON THE ACCOUNT (Kyle, 2026-10-01) ────────────────────────────────────────────────
 *
 * "What use is having photos uploaded that cannot be attached? … Having the photos linked to the
 * job is necessary but that should not eleminate them from being selected because building an
 * estimate will often come from what is found on the job and sending the photos as evidence is
 * our standard."
 *
 * Before this the picker offered one property's `VisitPhoto`s and nothing else — an account with
 * two addresses could not send a photo from the other one, and photos added while BUILDING the
 * estimate (`DraftPhoto`, a separate table) could not be emailed at all. Now it offers every
 * `VisitPhoto` across every property on the ACCOUNT (one query per property, reusing
 * `propertyPhotosQuery` exactly as `AccountPhotoGallery` does — no second photo query). That is
 * the only source: since plan A (2026-10-02) a photo added while building the estimate IS a
 * `VisitPhoto` on the consultation job, so the `DraftPhoto` branch this once had is gone.
 *
 * THE SERVER ENFORCES OWNERSHIP, NOT THIS LIST. `issuedEstimateSend.ts`'s `photoAttachments`
 * re-checks every ticked id against the estimate's `customerId` before it ever reads bytes —
 * this component choosing what to ASK FOR is not the security boundary.
 */
export function PhotoAttachPicker(props: {
  properties: Array<{ id: string; name: string; addressLine1: string; city: string }>;
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const propertyQueries = useQueries({
    queries: props.properties.map((property) => propertyPhotosQuery(property.id)),
  });

  const propertyLabel = (propertyId: string) => {
    const p = props.properties.find((candidate) => candidate.id === propertyId);
    return p ? `${p.name} — ${p.addressLine1}, ${p.city}` : "Address removed";
  };

  type PickerPhoto = { id: string; path: string; alt: string; date: string; title: string };
  const combined: PickerPhoto[] = [];
  props.properties.forEach((property, i) => {
    const data = propertyQueries[i]?.data;
    if (!data) return;
    for (const p of data.jobPhotos) {
      combined.push({
        id: p.id,
        path: `/health-record-admin/visit-photos/${p.id}`,
        alt: p.caption ?? "job photo",
        date: p.visitDate,
        title: `${new Date(p.visitDate).toLocaleDateString()} · ${p.jobType || p.purpose || "Job"} — ${propertyLabel(property.id)}${p.caption ? ` — ${p.caption}` : ""}`,
      });
    }
  });
  combined.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  /*
    IT SAYS WHY IT IS EMPTY (Kyle, 2026-10-01: "I am ready to send this estimate but want to
    include all the job photos … still do not see a way to attach the photos. Are the photos
    being auto attached?").

    This used to `return null` on an empty list, so a send screen with no job photos at the
    address showed NOTHING between the report checkboxes and the Email button — identical to the
    control being broken or missing. Kyle could not tell "there is nothing to attach" from "the
    attach control is gone", and reasonably wondered whether photos were going out silently.
    Nothing is ever attached without being ticked here.

    Now that the picker reaches every property on the account, "empty" genuinely means there is
    nothing on the account yet — not "wrong address".
  */
  if (combined.length === 0) {
    return (
      <p className="mt-2 text-xs text-rce-soft">
        No photos on this account yet, so there is nothing to attach. Photos on any job at any
        address on this account — including ones added while building an estimate — will appear
        here. Nothing is attached unless you tick it.
      </p>
    );
  }
  const toggle = (id: string) => {
    if (props.selected.includes(id)) props.onChange(props.selected.filter((x) => x !== id));
    else if (props.selected.length < 10) props.onChange([...props.selected, id]);
  };
  return (
    <div className="mt-2">
      <p className="mb-1 text-xs text-rce-soft">
        Attach photos ({props.selected.length ? `${props.selected.length} selected` : "optional"}, max 10):
      </p>
      <div className="grid max-h-40 grid-cols-4 gap-1.5 overflow-y-auto sm:grid-cols-6">
        {combined.map((p) => (
          <button
            key={p.id}
            type="button"
            className={`relative overflow-hidden rounded border-2 ${
              props.selected.includes(p.id) ? "border-rce-accent" : "border-transparent"
            }`}
            onClick={() => toggle(p.id)}
            title={p.title}
          >
            <AuthedPhoto path={p.path} alt={p.alt} className="h-16 w-full object-cover" />
            {props.selected.includes(p.id) && (
              <span className="absolute right-0.5 top-0.5 rounded bg-rce-accent px-1 text-[10px] font-bold text-rce-text">✓</span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
