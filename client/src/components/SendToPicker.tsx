/**
 * "Send to which address?" (Kyle, 2026-08-25: "resend estimates and select a
 * specific email to resend it to.")
 *
 * Lists the account's primary email plus every labeled contact that carries
 * one, with a free-typed one-off at the bottom. Renders as a select + optional
 * input; the chosen address comes back through onChange as a plain string (or
 * null meaning "primary — let the server default").
 *
 * CC (Kyle, 2026-10-24: "I need to be able to send emails to multiple recipients at once." /
 * "The email will be the same as doing a CC email."): beside the To select sits "+ Add CC", which
 * lists the same addresses plus "Other address…". Each CC shows as a chip with × to take it off
 * again; the whole list comes back through onCcChange. One message, one To, any number of CCs.
 *
 * SAVE A TYPED ADDRESS (Kyle, 2026-10-24: "If I type a new address I should have the option to
 * save it as an additional contact."): wherever an address is typed — Other address for the To or
 * for a CC — a "Save as contact" control with a required Label sits beside it. It adds a
 * CustomerContact through the same call the account page's Additional contacts uses, so the
 * address then appears in this picker and in that list, where it can be edited or deleted. It is
 * not offered for an address that is already the primary or a saved contact.
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";

const ADDRESS = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function isAddress(value: string): boolean {
  return ADDRESS.test(value.trim());
}

/** The CC list as chips, each with × (everything added can be taken off again). */
export function CcChips({ cc, onRemove, children }: {
  cc: string[];
  onRemove: (address: string) => void;
  /** Extra per-chip controls (the picker's "Save as contact"). */
  children?: (address: string) => React.ReactNode;
}) {
  if (cc.length === 0) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1" aria-label="CC recipients">
      {cc.map((address) => (
        <span key={address} className="inline-flex flex-wrap items-center gap-1">
          <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-800">
            CC {address}
            <button
              type="button"
              className="font-bold text-gray-500 hover:text-red-700"
              aria-label={`Remove CC ${address}`}
              title="Take this address off the CC list"
              onClick={() => onRemove(address)}
            >
              ×
            </button>
          </span>
          {children?.(address)}
        </span>
      ))}
    </span>
  );
}

/**
 * "Save as contact" for a typed address: one click opens a required Label; Save adds it to the
 * account's Additional contacts. Says what happened inline, success or failure.
 */
export function SaveAsContact({ accountId, email, primaryEmail }: { accountId: string; email: string; primaryEmail?: string | null }) {
  const queryClient = useQueryClient();
  const { data: contacts } = useQuery({
    queryKey: ["accountContacts", accountId],
    queryFn: () => api.accountContacts(accountId),
  });
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [saved, setSaved] = useState<{ email: string; text: string } | null>(null);
  const save = useMutation({
    mutationFn: () => api.addAccountContact(accountId, { label: label.trim(), email: email.trim() }),
    onSuccess: () => {
      setSaved({ email: email.trim(), text: `Saved ${email.trim()} as "${label.trim()}" in Additional contacts.` });
      setOpen(false);
      setLabel("");
      void queryClient.invalidateQueries({ queryKey: ["accountContacts", accountId] });
    },
  });

  // The confirmation outlives the refetch that makes the address "known".
  if (saved && saved.email === email.trim()) {
    return <span className="text-xs text-rce-success" role="status">{saved.text}</span>;
  }
  // Not offered for an address that is already the primary or a saved contact.
  const key = email.trim().toLowerCase();
  const known = key === (primaryEmail ?? "").trim().toLowerCase()
    || (contacts ?? []).some((c) => (c.email ?? "").trim().toLowerCase() === key);
  if (!isAddress(email) || known) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {!open ? (
        <button type="button" className="text-xs text-rce-accent underline" onClick={() => setOpen(true)}>
          Save as contact
        </button>
      ) : (
        <>
          <input
            className="field text-xs"
            placeholder="Label, e.g. Property manager"
            aria-label="Contact label"
            value={label}
            maxLength={80}
            onChange={(e) => setLabel(e.target.value)}
          />
          <button
            type="button"
            className="btn btn-secondary text-xs"
            disabled={!label.trim() || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Saving…" : "Save contact"}
          </button>
          <button type="button" className="text-xs text-rce-muted underline" onClick={() => setOpen(false)}>
            Cancel
          </button>
        </>
      )}
      {save.isError && (
        <span className="text-xs text-red-700" role="alert">
          Could not save the contact: {(save.error as Error).message}
        </span>
      )}
    </span>
  );
}

export function SendToPicker({
  accountId,
  primaryEmail,
  onChange,
  onCcChange,
}: {
  accountId: string;
  primaryEmail?: string | null;
  onChange: (email: string | null) => void;
  /** The full CC list, every time it changes. Omit it and the picker offers no CC. */
  onCcChange?: (cc: string[]) => void;
}) {
  const { data: contacts } = useQuery({
    queryKey: ["accountContacts", accountId],
    queryFn: () => api.accountContacts(accountId),
  });
  const [choice, setChoice] = useState<string>("primary");
  const [custom, setCustom] = useState("");
  const [cc, setCc] = useState<string[]>([]);
  const [ccTyping, setCcTyping] = useState(false);
  const [ccCustom, setCcCustom] = useState("");

  const emailContacts = (contacts ?? []).filter((c) => c.email);

  const pick = (value: string) => {
    setChoice(value);
    if (value === "primary") onChange(null);
    else if (value === "custom") onChange(custom.trim() || null);
    else onChange(value);
  };

  const updateCc = (next: string[]) => {
    setCc(next);
    onCcChange?.(next);
  };
  const addCc = (address: string) => {
    const a = address.trim();
    if (!isAddress(a)) return;
    if (cc.some((c) => c.toLowerCase() === a.toLowerCase())) return;
    updateCc([...cc, a]);
  };
  const pickCc = (value: string) => {
    if (value === "") return;
    if (value === "custom") { setCcTyping(true); return; }
    setCcTyping(false);
    addCc(value);
  };
  const commitTypedCc = () => {
    if (!isAddress(ccCustom)) return;
    addCc(ccCustom);
    setCcCustom("");
    setCcTyping(false);
  };

  const ccOptions = [
    ...(primaryEmail ? [{ key: "primary", label: `Primary — ${primaryEmail}`, value: primaryEmail }] : []),
    ...emailContacts.map((c) => ({ key: c.id, label: `${c.label} — ${c.email}`, value: c.email! })),
  ].filter((o) => !cc.some((c) => c.toLowerCase() === o.value.trim().toLowerCase()));

  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <select className="field text-xs" value={choice} onChange={(e) => pick(e.target.value)} aria-label="Send to">
        <option value="primary">
          {primaryEmail ? `Primary — ${primaryEmail}` : "Primary email"}
        </option>
        {emailContacts.map((c) => (
          <option key={c.id} value={c.email!}>
            {c.label} — {c.email}
          </option>
        ))}
        <option value="custom">Other address…</option>
      </select>
      {choice === "custom" && (
        <>
          <input
            className="field text-xs"
            type="email"
            placeholder="name@example.com"
            value={custom}
            onChange={(e) => {
              setCustom(e.target.value);
              onChange(e.target.value.trim() || null);
            }}
          />
          <SaveAsContact accountId={accountId} email={custom} primaryEmail={primaryEmail} />
        </>
      )}

      {onCcChange && (
        <>
          <select className="field text-xs" value="" onChange={(e) => pickCc(e.target.value)} aria-label="Add CC">
            <option value="">+ Add CC</option>
            {ccOptions.map((o) => (
              <option key={o.key} value={o.value}>{o.label}</option>
            ))}
            <option value="custom">Other address…</option>
          </select>
          {ccTyping && (
            <>
              <input
                className="field text-xs"
                type="email"
                placeholder="cc@example.com"
                aria-label="CC address"
                value={ccCustom}
                onChange={(e) => setCcCustom(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); commitTypedCc(); }
                }}
              />
              <button type="button" className="btn btn-secondary text-xs" disabled={!isAddress(ccCustom)} onClick={commitTypedCc}>
                Add
              </button>
              <SaveAsContact accountId={accountId} email={ccCustom} primaryEmail={primaryEmail} />
            </>
          )}
          <CcChips cc={cc} onRemove={(a) => updateCc(cc.filter((c) => c !== a))}>
            {(address) => <SaveAsContact accountId={accountId} email={address} primaryEmail={primaryEmail} />}
          </CcChips>
        </>
      )}
    </span>
  );
}
