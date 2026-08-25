/**
 * "Send to which address?" (Kyle, 2026-08-25: "resend estimates and select a
 * specific email to resend it to.")
 *
 * Lists the account's primary email plus every labeled contact that carries
 * one, with a free-typed one-off at the bottom. Renders as a select + optional
 * input; the chosen address comes back through onChange as a plain string (or
 * null meaning "primary — let the server default").
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

export function SendToPicker({
  accountId,
  primaryEmail,
  onChange,
}: {
  accountId: string;
  primaryEmail?: string | null;
  onChange: (email: string | null) => void;
}) {
  const { data: contacts } = useQuery({
    queryKey: ["accountContacts", accountId],
    queryFn: () => api.accountContacts(accountId),
  });
  const [choice, setChoice] = useState<string>("primary");
  const [custom, setCustom] = useState("");

  const emailContacts = (contacts ?? []).filter((c) => c.email);

  const pick = (value: string) => {
    setChoice(value);
    if (value === "primary") onChange(null);
    else if (value === "custom") onChange(custom.trim() || null);
    else onChange(value);
  };

  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <select className="field text-xs" value={choice} onChange={(e) => pick(e.target.value)}>
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
      )}
    </span>
  );
}
