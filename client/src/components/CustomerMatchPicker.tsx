import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import type { CustomerMatch } from "../lib/types";

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
}

const DEBOUNCE_MS = 400;

/** Their own words for why this surfaced — never a bare score. */
function describeMatch(matchedOn: CustomerMatch["matchedOn"]): string {
  if (matchedOn.length === 0) return "no direct match";
  if (matchedOn.length === 1) return `matched on ${matchedOn[0]}`;
  const last = matchedOn[matchedOn.length - 1];
  return `matched on ${matchedOn.slice(0, -1).join(", ")} and ${last}`;
}

const addressLabel = (p: CustomerMatch["properties"][number]) =>
  `${p.name} — ${p.addressLine1}${p.addressLine2 ? `, ${p.addressLine2}` : ""}, ${p.city}`;

export function CustomerMatchPicker({
  phone, email, name, linkedCustomerId, linkedPropertyId, onLink, onUnlink, mode = "link",
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
    queryKey: ["customerMatches", debounced],
    queryFn: () => api.customerMatches({
      phone: debounced.phone ?? undefined,
      email: debounced.email ?? undefined,
      name: debounced.name ?? undefined,
    }),
    enabled: hasQuery,
  });

  const matches = data?.matches ?? [];
  const linked = matches.find((m) => m.customerId === linkedCustomerId);

  if (linkedCustomerId) {
    const linkedAddress = linked?.properties.find((p) => p.id === linkedPropertyId);
    return (
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
    );
  }

  if (matches.length === 0) return null;

  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 p-3">
      <p className="text-sm font-medium text-amber-900">
        {matches.length === 1
          ? "This looks like an account you already have"
          : `${matches.length} existing accounts look like this`}
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
              {` · ${describeMatch(match.matchedOn)}`}
              {match.visitCount > 0 && ` · ${match.visitCount} job${match.visitCount === 1 ? "" : "s"}`}
            </p>

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
    </div>
  );
}
