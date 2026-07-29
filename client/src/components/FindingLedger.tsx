import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { PropertyFinding } from "../lib/types";

/**
 * The finding ledger for an account or a property.
 *
 * Split by track, because they are different businesses. The defect list is a
 * remediation obligation and its close-out is a code-cited certificate. The
 * upgrade list is a pipeline — wear with a known expiry date, and work that
 * meets code but not our standard. Showing them in one undifferentiated list
 * would let a sales follow-up borrow a violation's urgency, which is exactly the
 * thing the ledger exists to keep honest.
 */

const LIVE = new Set(["open", "scheduled"]);

const STATUS_LABEL: Record<string, string> = {
  open: "Open",
  scheduled: "Scheduled",
  corrected: "Corrected",
  upgraded: "Upgraded",
  declined: "Declined",
  superseded: "No longer applies",
};

const STATUS_TONE: Record<string, string> = {
  open: "bg-red-100 text-red-800",
  scheduled: "bg-amber-100 text-amber-800",
  corrected: "bg-emerald-100 text-emerald-800",
  upgraded: "bg-emerald-100 text-emerald-800",
  declined: "bg-slate-200 text-slate-700",
  superseded: "bg-slate-100 text-slate-500",
};

const SEVERITY_LABEL: Record<string, string> = {
  FAIL: "Needs correction",
  MONITOR: "Monitor",
  BELOW_STANDARD: "Below standard",
};

const PARTY_LABEL: Record<string, string> = {
  red_cedar: "Red Cedar Electric",
  owner_self: "the owner",
  third_party: "a third party",
};

interface Props {
  findings: PropertyFinding[];
  /** Property id → readable label, so a multi-address account stays legible. */
  propertyLabels?: Record<string, string>;
  title?: string;
}

export function FindingLedger({ findings, propertyLabels, title = "Finding ledger" }: Props) {
  const [showResolved, setShowResolved] = useState(false);

  const { defects, upgrades, needsCloseout } = useMemo(() => {
    const visible = showResolved ? findings : findings.filter((f) => LIVE.has(f.status) || f.status === "declined");
    return {
      defects: visible.filter((f) => f.track === "defect"),
      upgrades: visible.filter((f) => f.track === "upgrade"),
      // A finding whose item passed later, still waiting for someone with a
      // licence to say what was actually done about it.
      needsCloseout: findings.filter((f) => LIVE.has(f.status) && f.verifiedPassAt),
    };
  }, [findings, showResolved]);

  if (findings.length === 0) {
    return (
      <section className="card mt-5 p-4">
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="mt-1 text-sm text-rce-muted">
          Nothing documented yet. Findings open automatically when a Health Record is filed.
        </p>
      </section>
    );
  }

  return (
    <section className="card mt-5 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">{title}</h2>
          <p className="text-xs text-rce-muted">
            What was documented at these addresses, and whether it was ever resolved.
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm text-rce-muted">
          <input
            type="checkbox"
            checked={showResolved}
            onChange={(e) => setShowResolved(e.target.checked)}
          />
          Show resolved
        </label>
      </div>

      {needsCloseout.length > 0 && (
        <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3">
          <p className="text-sm font-medium text-amber-900">
            {needsCloseout.length} finding{needsCloseout.length === 1 ? "" : "s"} passed on a later
            assessment and {needsCloseout.length === 1 ? "is" : "are"} awaiting close-out.
          </p>
          <p className="mt-1 text-xs text-amber-800">
            A pass is evidence that the condition is gone — not a record of what was done, by whom,
            or when. Close each one out with a resolution so the certificate can state it.
          </p>
        </div>
      )}

      <TrackSection
        label="Code defects and hazards"
        blurb="Documented violations. These close out as corrected and produce a certificate of correction."
        findings={defects}
        propertyLabels={propertyLabels}
      />
      <TrackSection
        label="Upgrades and planned replacements"
        blurb="Not violations. Wear against a published service life, or work that meets code but not our standard."
        findings={upgrades}
        propertyLabels={propertyLabels}
      />
    </section>
  );
}

function TrackSection({
  label, blurb, findings, propertyLabels,
}: {
  label: string;
  blurb: string;
  findings: PropertyFinding[];
  propertyLabels?: Record<string, string>;
}) {
  if (findings.length === 0) return null;
  return (
    <div className="mt-4">
      <h3 className="text-sm font-semibold">{label}</h3>
      <p className="text-xs text-rce-soft">{blurb}</p>
      <div className="mt-2 space-y-2">
        {findings.map((finding) => (
          <FindingRow
            key={finding.id}
            finding={finding}
            propertyLabel={propertyLabels?.[finding.propertyId]}
          />
        ))}
      </div>
    </div>
  );
}

const RESOLUTION_METHODS = [
  { value: "corrected", label: "Corrected", tracks: ["defect"] },
  { value: "replaced", label: "Replaced", tracks: ["defect", "upgrade"] },
  { value: "upgraded", label: "Upgraded", tracks: ["upgrade"] },
  { value: "equipment_removed", label: "Equipment removed", tracks: ["defect", "upgrade"] },
  { value: "verified_prior_repair", label: "Verified a prior repair", tracks: ["defect", "upgrade"] },
];

function FindingRow({ finding, propertyLabel }: { finding: PropertyFinding; propertyLabel?: string }) {
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);

  return (
    <div className="rounded-lg border border-rce-border p-3">
      <button type="button" className="flex w-full items-start justify-between gap-3 text-left" onClick={() => setOpen(!open)}>
        <span className="min-w-0">
          <span className="block font-medium">
            {finding.critical && <span className="mr-1 text-red-600">●</span>}
            {finding.itemId}. {finding.title}
          </span>
          <span className="block text-xs text-rce-soft">
            {propertyLabel ? `${propertyLabel} · ` : ""}
            {SEVERITY_LABEL[finding.severity] ?? finding.severity}
            {" · documented "}
            {new Date(finding.openedAt).toLocaleDateString()}
            {finding.cycle > 1 && ` · occurrence ${finding.cycle}`}
            {finding.observedCount > 1 && ` · seen ${finding.observedCount}×`}
            {finding.expectedEolYear && ` · end of life ${finding.expectedEolYear}`}
          </span>
        </span>
        <span className={`shrink-0 rounded px-2 py-0.5 text-xs font-medium ${STATUS_TONE[finding.status] ?? "bg-slate-100 text-slate-600"}`}>
          {STATUS_LABEL[finding.status] ?? finding.status}
        </span>
      </button>

      {open && (
        <div className="mt-3 space-y-2 border-t border-rce-border pt-3 text-sm">
          <p>{finding.findingText}</p>
          {finding.resolutionNote && (
            <p className="text-rce-muted">Recommended: {finding.resolutionNote}</p>
          )}
          <p className="text-xs text-rce-soft">
            {finding.citationsAvailable
              ? finding.citations.join(" · ")
              : "Citations unavailable — pre-ledger record."}
            {` · documented under ${finding.jurisdictionId}`}
          </p>

          {finding.verifiedPassAt && LIVE.has(finding.status) && (
            <p className="rounded bg-amber-50 px-2 py-1 text-xs text-amber-900">
              Passed on a later assessment ({new Date(finding.verifiedPassAt).toLocaleDateString()}).
              That's evidence, not a cure — close it out to record what was actually done.
            </p>
          )}

          {finding.resolvedAt && (
            <p className="text-xs text-emerald-800">
              {finding.resolutionMethod ?? "Resolved"} on {new Date(finding.resolvedAt).toLocaleDateString()}
              {finding.resolvedByParty ? ` by ${PARTY_LABEL[finding.resolvedByParty] ?? finding.resolvedByParty}` : ""}
              {finding.certificateDocId ? " · certificate issued" : " · no certificate issued yet"}
            </p>
          )}

          {finding.declinedAt && (
            <p className="text-xs text-rce-muted">
              Declined {new Date(finding.declinedAt).toLocaleDateString()} by {finding.declinedByName}
              {finding.declinedByRelation ? ` (${finding.declinedByRelation.replace(/_/g, " ")})` : ""}.
            </p>
          )}

          {LIVE.has(finding.status) && !closing && (
            <button className="btn btn-secondary" onClick={() => setClosing(true)}>
              Close this out
            </button>
          )}
          {closing && <CloseOutForm finding={finding} onDone={() => setClosing(false)} />}

          {(finding.status === "corrected" || finding.status === "upgraded") && (
            <IssueCertificate finding={finding} />
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The owner's attestation.
 *
 * Deliberately not one click. Method, who did the work, and what was actually
 * done are all required, because those three lines are the entire content of the
 * certificate this produces — and the certificate is signed under a licence.
 */
function CloseOutForm({ finding, onDone }: { finding: PropertyFinding; onDone: () => void }) {
  const queryClient = useQueryClient();
  const methods = RESOLUTION_METHODS.filter((m) => m.tracks.includes(finding.track));
  const [method, setMethod] = useState(methods[0]?.value ?? "corrected");
  const [party, setParty] = useState<"red_cedar" | "owner_self" | "third_party">("red_cedar");
  const [partyName, setPartyName] = useState("");
  const [detail, setDetail] = useState("");
  const [attestedBy, setAttestedBy] = useState("");

  const resolve = useMutation({
    mutationFn: () =>
      api.updateLedgerFinding(finding.id, {
        toStatus: "resolved",
        resolutionMethod: method,
        resolvedByParty: party,
        resolvedByPartyName: partyName || null,
        resolutionDetail: detail,
        attestedBy,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries();
      onDone();
    },
  });

  return (
    <div className="space-y-2 rounded-lg border border-rce-border bg-rce-surface p-3">
      <div className="grid gap-2 md:grid-cols-2">
        <label className="text-xs font-medium">
          What happened
          <select className="field mt-1" value={method} onChange={(e) => setMethod(e.target.value)}>
            {methods.map((m) => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>
        </label>
        <label className="text-xs font-medium">
          Who did it
          <select
            className="field mt-1"
            value={party}
            onChange={(e) => setParty(e.target.value as typeof party)}
          >
            <option value="red_cedar">Red Cedar Electric</option>
            <option value="owner_self">The owner</option>
            <option value="third_party">A third-party contractor</option>
          </select>
        </label>
      </div>
      {party !== "red_cedar" && (
        <input
          className="field"
          placeholder="Who, by name — it goes on the certificate"
          value={partyName}
          onChange={(e) => setPartyName(e.target.value)}
        />
      )}
      <textarea
        className="field"
        rows={2}
        placeholder="What was actually done. This is printed verbatim."
        value={detail}
        onChange={(e) => setDetail(e.target.value)}
      />
      <input
        className="field"
        placeholder="Attesting on behalf of Red Cedar (your name)"
        value={attestedBy}
        onChange={(e) => setAttestedBy(e.target.value)}
      />
      {party !== "red_cedar" && (
        <p className="text-xs text-amber-800">
          The certificate will state plainly that Red Cedar neither performed nor re-assessed this
          work. That's the honest claim, and it's the one that holds up.
        </p>
      )}
      <div className="flex gap-2">
        <button
          className="btn btn-primary"
          disabled={!detail.trim() || !attestedBy.trim() || resolve.isPending}
          onClick={() => resolve.mutate()}
        >
          {resolve.isPending ? "Saving…" : "Record resolution"}
        </button>
        <button className="btn btn-secondary" onClick={onDone}>Cancel</button>
      </div>
      {resolve.error && <p className="text-xs text-red-600">{(resolve.error as Error).message}</p>}
    </div>
  );
}

function IssueCertificate({ finding }: { finding: PropertyFinding }) {
  const queryClient = useQueryClient();
  const [attestedBy, setAttestedBy] = useState("");
  const issue = useMutation({
    mutationFn: () =>
      api.issueFindingCertificate({
        propertyId: finding.propertyId,
        findingIds: [finding.id],
        track: finding.track,
        attestedBy,
      }),
    onSuccess: () => void queryClient.invalidateQueries(),
  });

  if (finding.certificateDocId) {
    return (
      <p className="text-xs text-emerald-800">
        {finding.track === "defect" ? "Certificate of correction" : "Record of upgrade"} issued.
      </p>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        className="field max-w-xs"
        placeholder="Attesting name"
        value={attestedBy}
        onChange={(e) => setAttestedBy(e.target.value)}
      />
      <button
        className="btn btn-secondary"
        disabled={!attestedBy.trim() || issue.isPending}
        onClick={() => issue.mutate()}
      >
        {issue.isPending
          ? "Generating…"
          : finding.track === "defect"
            ? "Issue certificate of correction"
            : "Issue record of upgrade"}
      </button>
      {issue.error && <p className="text-xs text-red-600">{(issue.error as Error).message}</p>}
    </div>
  );
}
