import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { useDrawerParams } from "../lib/drawers";
import { formatReceived } from "../../../shared/calendarDay";
import { OpenDrawerButton } from "./drawers/OpenDrawerButton";
import type { CustomerMatch, LeadMatch } from "../lib/types";

/**
 * "You might already have this customer."
 *
 * Converting a lead used to always create a new account, so a repeat customer
 * calling about a second property got a duplicate instead of a second address.
 * This is the surface that fixes it, and it deliberately asks rather than acts:
 * phone matching is fuzzy — a landlord and a tenant can share a number — and an
 * account merged by mistake is hard to unpick.
 *
 * Renders **nothing** when there are no matches. A panel that appears empty
 * teaches people to dismiss it without reading.
 *
 * THE LEAD FORM turns on two more things (plan lead-intake-fixes F2, Kyle 2026-11-15): an account
 * with the very same full name but no phone or email in common ("same name only — check before
 * linking"), and the leads already on the Leads page that look like this one ("Already a lead").
 * Both are off by default. This is still the ONE panel — no second one beside it.
 */

interface Props {
  phone?: string | null;
  email?: string | null;
  name?: string | null;
  linkedCustomerId: string | null;
  linkedPropertyId: string | null;
  onLink: (customerId: string, propertyId: string | null) => void;
  onUnlink: () => void;
  /** Shown instead of "link" where linking isn't possible (creating an account). */
  mode?: "link" | "navigate";
  /** Lead form only: also surface an account whose FULL name matches with nothing else in common. */
  includeNameOnly?: boolean;
  /** Lead form only: also list open and lost leads that look like this one. */
  includeLeads?: boolean;
  /** The lead being edited, so it never lists itself. */
  excludeLeadId?: string | null;
}

const DEBOUNCE_MS = 400;

/** Their own words for why this surfaced — never a bare score. */
function describeMatch(matchedOn: CustomerMatch["matchedOn"]): string {
  if (matchedOn.length === 0) return "no direct match";
  if (matchedOn.length === 1) return `matched on ${matchedOn[0]}`;
  const last = matchedOn[matchedOn.length - 1];
  return `matched on ${matchedOn.slice(0, -1).join(", ")} and ${last}`;
}

/** A name with no phone or email behind it: the weakest signal, and worded as such. */
const isNameOnly = (matchedOn: CustomerMatch["matchedOn"]) => matchedOn.length === 1 && matchedOn[0] === "name";

const addressLabel = (p: CustomerMatch["properties"][number]) =>
  `${p.name} — ${p.addressLine1}${p.addressLine2 ? `, ${p.addressLine2}` : ""}, ${p.city}`;

const LEAD_STATUS_WORDS: Record<LeadMatch["status"], string> = {
  new: "open — new",
  contacted: "open — contacted",
  lost: "lost",
  converted: "converted",
};

/**
 * "Already a lead (N)" — the leads that look like the one being typed. "Open lead" raises that
 * lead's drawer over the form through the same opener every list uses, so a half-typed new lead
 * is not thrown away (the drawer rides on the URL's ?lead= and the page underneath stays put).
 */
function LeadMatches({ leads, editingLeadId }: { leads: LeadMatch[]; editingLeadId?: string | null }) {
  const drawers = useDrawerParams();
  return (
    <div className="mt-3 rounded border border-amber-200 bg-white p-2" data-lead-matches="">
      <p className="text-sm font-medium text-amber-900">
        {leads.length === 1 ? "Already a lead (1)" : `Already a lead (${leads.length})`}
      </p>
      <div className="mt-2 space-y-2">
        {leads.map((lead) => (
          <div key={lead.leadId} className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-sm font-medium">{lead.name}</p>
              <p className="text-xs text-rce-muted">
                {[lead.phone, lead.email].filter(Boolean).join(" · ")}
                {` · ${LEAD_STATUS_WORDS[lead.status] ?? lead.status}`}
                {` · received ${formatReceived(lead.receivedAt)}`}
                {` · ${describeMatch(lead.matchedOn)}`}
              </p>
            </div>
            <OpenDrawerButton
              kind="lead"
              id={lead.leadId}
              onOpen={drawers.open}
              label="Open lead"
              className="btn btn-secondary text-xs"
            />
          </div>
        ))}
      </div>
      {editingLeadId ? (
        <p className="mt-2 text-xs text-amber-800">
          Opening another lead replaces this one on screen — save your changes first.
        </p>
      ) : null}
    </div>
  );
}

export function CustomerMatchPicker({
  phone, email, name, linkedCustomerId, linkedPropertyId, onLink, onUnlink, mode = "link",
  includeNameOnly = false, includeLeads = false, excludeLeadId = null,
}: Props) {
  // Debounced so it doesn't fire on every keystroke of a phone number.
  const [debounced, setDebounced] = useState({ phone, email, name });
  useEffect(() => {
    const timer = setTimeout(() => setDebounced({ phone, email, name }), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [phone, email, name]);

  const hasQuery = Boolean(
    debounced.phone?.trim() || debounced.email?.trim() || debounced.name?.trim(),
  );

  const { data } = useQuery({
    queryKey: ["customerMatches", debounced, { includeNameOnly, includeLeads, excludeLeadId }],
    queryFn: () => api.customerMatches({
      phone: debounced.phone ?? undefined,
      email: debounced.email ?? undefined,
      name: debounced.name ?? undefined,
      ...(includeNameOnly ? { includeNameOnly } : {}),
      ...(includeLeads ? { includeLeads } : {}),
      ...(excludeLeadId ? { excludeLeadId } : {}),
    }),
    enabled: hasQuery,
  });

  const matches = data?.matches ?? [];
  const leadMatches = data?.leadMatches ?? [];
  const linked = matches.find((m) => m.customerId === linkedCustomerId);

  if (linkedCustomerId) {
    const linkedAddress = linked?.properties.find((p) => p.id === linkedPropertyId);
    return (
      <div>
        <div className="rounded-lg border border-rce-accent bg-rce-accentBg p-3">
          <p className="text-sm font-medium">
            Linked to {linked?.name ?? "an existing account"}
            {linkedAddress ? ` — ${addressLabel(linkedAddress)}` : " — new address"}
          </p>
          <p className="mt-1 text-xs text-rce-muted">
            Converting this lead will add the job to that account instead of creating a new one.
          </p>
          <button type="button" className="btn btn-secondary mt-2 text-xs" onClick={onUnlink}>
            Unlink
          </button>
        </div>
        {/* Linking an account does not make a duplicate LEAD any less of one. */}
        {leadMatches.length > 0 ? (
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 mt-3">
            <LeadMatches leads={leadMatches} editingLeadId={excludeLeadId} />
          </div>
        ) : null}
      </div>
    );
  }

  if (matches.length === 0 && leadMatches.length === 0) return null;

  const allNameOnly = matches.length > 0 && matches.every((m) => isNameOnly(m.matchedOn));

  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 p-3">
      {matches.length > 0 ? (
        <>
          <p className="text-sm font-medium text-amber-900">
            {allNameOnly
              ? (matches.length === 1
                ? "An account has the same name"
                : `${matches.length} accounts have the same name`)
              : (matches.length === 1
                ? "This looks like an account you already have"
                : `${matches.length} existing accounts look like this`)}
          </p>
          <p className="mt-1 text-xs text-amber-800">
            {mode === "link"
              ? "Link it so the work lands on the account they already have — one account, any number of addresses."
              : "Open it instead of creating a second account for the same customer."}
          </p>

          <div className="mt-3 space-y-3">
            {matches.map((match) => (
              <div key={match.customerId} className="rounded border border-amber-200 bg-white p-2">
                <p className="text-sm font-medium">{match.name}</p>
                <p className="text-xs text-rce-muted">
                  {[match.phone, match.email].filter(Boolean).join(" · ")}
                  {isNameOnly(match.matchedOn)
                    ? " · same name only — check before linking"
                    : ` · ${describeMatch(match.matchedOn)}`}
                  {match.visitCount > 0 && ` · ${match.visitCount} job${match.visitCount === 1 ? "" : "s"}`}
                </p>
                {isNameOnly(match.matchedOn) ? (
                  <p className="mt-1 text-xs text-amber-800">
                    No phone or email in common. Two households can share a name — link it only if it is the same customer.
                  </p>
                ) : null}

                {mode === "navigate" ? (
                  <Link to={`/accounts/${match.customerId}`} className="btn btn-secondary mt-2 text-xs">
                    Open this account
                  </Link>
                ) : (
                  <div className="mt-2 space-y-1">
                    {match.properties.map((property) => (
                      <button
                        key={property.id}
                        type="button"
                        className="btn btn-secondary w-full text-left text-xs"
                        onClick={() => onLink(match.customerId, property.id)}
                      >
                        Use {addressLabel(property)}
                      </button>
                    ))}
                    <button
                      type="button"
                      className="btn btn-secondary w-full text-left text-xs"
                      onClick={() => onLink(match.customerId, null)}
                    >
                      Use this account — new address
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>

          {mode === "link" && (
            <p className="mt-3 text-xs text-amber-800">
              Not the same customer? Leave it unlinked — a new account will be created.
            </p>
          )}
        </>
      ) : null}

      {leadMatches.length > 0 ? <LeadMatches leads={leadMatches} editingLeadId={excludeLeadId} /> : null}
    </div>
  );
}
