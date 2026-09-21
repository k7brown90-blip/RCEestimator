/**
 * The server refused to convert because it would have created an account that looks like one
 * already on the books. Not an error — a question. Moved out of LeadsPage on 2026-09-20 so the
 * lead drawer asks it the same way.
 */

import { Modal } from "./Modal";
import type { CustomerMatch, Lead } from "../lib/types";
import type { api } from "../lib/api";

export type ConvertInput = NonNullable<Parameters<typeof api.convertLead>[1]>;

export function LeadDuplicatePicker({
  lead, matches, busy, error, onPick, onClose,
}: {
  lead: Lead;
  matches: CustomerMatch[];
  busy: boolean;
  error: string | null;
  onPick: (input: ConvertInput) => void;
  onClose: () => void;
}) {
  return (
    <Modal
      title="This might already be a customer"
      subtitle={`Converting ${lead.name} would create a new account.`}
      onClose={onClose}
    >
      <div className="space-y-3">
        {matches.map((match) => (
          <div key={match.customerId} className="rounded border border-rce-border p-3">
            <p className="text-sm font-medium">{match.name}</p>
            <p className="text-xs text-rce-muted">
              {[match.phone, match.email].filter(Boolean).join(" · ")}
              {match.visitCount > 0 && ` · ${match.visitCount} job${match.visitCount === 1 ? "" : "s"}`}
            </p>
            <div className="mt-2 space-y-1">
              {match.properties.map((property) => (
                <button
                  key={property.id}
                  type="button"
                  className="btn btn-secondary w-full text-left text-xs"
                  disabled={busy}
                  onClick={() => onPick({ customerId: match.customerId, propertyId: property.id })}
                >
                  Use {property.name} — {property.addressLine1}, {property.city}
                </button>
              ))}
              <button
                type="button"
                className="btn btn-secondary w-full text-left text-xs"
                disabled={busy}
                onClick={() => onPick({ customerId: match.customerId })}
              >
                Use this account — add the lead's address to it
              </button>
            </div>
          </div>
        ))}

        <button
          type="button"
          className="btn btn-primary w-full text-xs"
          disabled={busy}
          onClick={() => onPick({ createNewAccount: true })}
        >
          Not the same customer — create a new account
        </button>
        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>
    </Modal>
  );
}
