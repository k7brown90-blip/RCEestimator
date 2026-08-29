import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, fetchProtectedObjectUrl } from "../lib/api";
import type { PhotoTag, VisitPhotoMeta } from "../lib/api";
import { downscale } from "../lib/images";

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
            className="rounded border border-rce-border bg-white px-1.5 py-0.5 text-xs text-rce-muted"
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
            className="text-xs text-red-500 hover:text-red-700"
            disabled={remove.isPending}
            onClick={() => {
              if (window.confirm("Delete this photo? This cannot be undone.")) remove.mutate();
            }}
          >
            Delete
          </button>
        </div>
        <input
          className="w-full rounded border border-rce-border/60 px-1.5 py-1 text-xs"
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
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          onClick={() => setViewing(false)}
        >
          <AuthedPhoto
            path={`/health-record-admin/visit-photos/${photo.id}`}
            alt={photo.caption ?? "job photo"}
            className="max-h-full max-w-full rounded-lg object-contain"
          />
        </div>
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

  const { data: photos = [] } = useQuery({
    queryKey: ["visit-photos", props.visitId],
    queryFn: () => api.visitPhotos(props.visitId),
  });
  const { data: history } = useQuery({
    queryKey: ["property-photos", props.propertyId],
    queryFn: () => api.propertyPhotos(props.propertyId),
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
            className="rounded-lg border border-rce-border bg-white px-2 py-1.5 text-xs text-rce-muted"
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
                ? "border-rce-accent bg-rce-accent text-white"
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
          className="text-sm font-medium text-rce-accent hover:underline"
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
                        className="h-24 w-full rounded object-cover"
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
                        className="h-24 w-full rounded object-cover"
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
    </article>
  );
}

/**
 * Read-only photo browser for the ACCOUNT page (Kyle, 2026-08-29: "I don't see
 * where to find the photos, I need to be able to access them") — every photo
 * at an address: job photos across visits plus Health Record assessment shots.
 * Uploading and tagging stay on the visit page's gallery, where the job
 * context lives; each photo links back through its visit.
 */
export function PropertyPhotoSection(props: { propertyId: string; propertyLabel: string }) {
  const [open, setOpen] = useState(false);
  const { data: photos } = useQuery({
    queryKey: ["property-photos", props.propertyId],
    queryFn: () => api.propertyPhotos(props.propertyId),
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
                      className="h-24 w-full rounded object-cover"
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
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-rce-soft">
                Electrical assessment photos
              </h4>
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6">
                {assessmentPhotos.map((p) => (
                  <figure key={p.id}>
                    <AuthedPhoto
                      path={`/health-record-admin/inspection-photos/${p.id}`}
                      alt="assessment photo"
                      className="h-24 w-full rounded object-cover"
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
  );
}

/**
 * Compact photo picker for the estimate/invoice send flows — tick the photos
 * to ride the email. Lists every job photo at the address so before/after from
 * the right visit is always reachable, capped at 10 per send (server cap).
 */
export function PhotoAttachPicker(props: {
  propertyId: string;
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const { data: history } = useQuery({
    queryKey: ["property-photos", props.propertyId],
    queryFn: () => api.propertyPhotos(props.propertyId),
  });
  const photos = history?.jobPhotos ?? [];
  if (photos.length === 0) return null;
  const toggle = (id: string) => {
    if (props.selected.includes(id)) props.onChange(props.selected.filter((x) => x !== id));
    else if (props.selected.length < 10) props.onChange([...props.selected, id]);
  };
  return (
    <div className="mt-2">
      <p className="mb-1 text-xs text-rce-soft">
        Attach job photos ({props.selected.length ? `${props.selected.length} selected` : "optional"}, max 10):
      </p>
      <div className="grid max-h-40 grid-cols-4 gap-1.5 overflow-y-auto sm:grid-cols-6">
        {photos.map((p) => (
          <button
            key={p.id}
            type="button"
            className={`relative overflow-hidden rounded border-2 ${
              props.selected.includes(p.id) ? "border-rce-accent" : "border-transparent"
            }`}
            onClick={() => toggle(p.id)}
            title={`${new Date(p.visitDate).toLocaleDateString()}${p.caption ? ` — ${p.caption}` : ""}`}
          >
            <AuthedPhoto
              path={`/health-record-admin/visit-photos/${p.id}`}
              alt={p.caption ?? "job photo"}
              className="h-16 w-full object-cover"
            />
            {props.selected.includes(p.id) && (
              <span className="absolute right-0.5 top-0.5 rounded bg-rce-accent px-1 text-[10px] font-bold text-white">✓</span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
