import { useNavigate, useParams } from "react-router-dom";
import { LeadForm } from "../components/LeadForm";
import { PageHeader } from "../components/PageHeader";
import { useLead } from "../lib/recordQueries";

/**
 * Manual lead entry and editing.
 *
 * A page rather than a modal: there are twenty-odd fields, and at `Modal`'s
 * max-w-lg the save button scrolls out of sight. One component serves both
 * `/leads/new` and `/leads/:leadId/edit` so the field set, the validation and the
 * duplicate picker exist once — the old inline row-edit form covered six fields
 * and would have drifted from this immediately.
 *
 * The form itself lives in components/LeadForm.tsx since 2026-09-20, so the lead
 * drawer can edit a lead in place with the same field set; this page is the
 * routed shell around it.
 */
export function LeadFormPage() {
  const { leadId } = useParams();
  const navigate = useNavigate();
  const isEdit = Boolean(leadId);

  const { data: existing, isLoading } = useLead(leadId);

  if (isEdit && isLoading) return <p className="text-sm text-rce-muted">Loading lead…</p>;
  if (isEdit && !existing) return <p className="text-sm text-rce-muted">Lead not found.</p>;

  return (
    <div className="pb-24">
      <PageHeader
        title={isEdit ? `Edit ${existing?.name}` : "New Lead"}
        subtitle={
          isEdit
            ? "Everything the phone agent can record, editable here."
            : "A walk-in, a referral, a job written on the back of an invoice."
        }
      />
      <LeadForm
        existing={existing ?? null}
        onSaved={(lead) => navigate("/leads", { state: { highlight: lead.id } })}
        onCancel={() => navigate("/leads")}
      />
    </div>
  );
}
