/**
 * "Text the customer" - THE ONE TEXT BOX on a record's Conversation (Kyle, 2026-11-26: "Every lead and every customer with a phone number
 * gets a working text box in Conversation, whether or not they came from the website form or have been converted to an account.").
 *
 * The Conversation (RecordConversation.tsx) shows it on the Account page, the Lead drawer and the Job drawer, beside "Add call note" and
 * "Email the customer". Click "Text the customer", type the words, click "Send text". The text goes to the phone on the record through the
 * hub's one sender (POST /communications/text -> services/hubSend.ts) and appears in the same Conversation as an "Office" text.
 *
 * It is greyed, with the reason on the screen, only when a text cannot go: the record has no phone on file, or the person replied STOP
 * (the ONLY thing that blocks a text). Never because they were not "asked" - there is no consent step.
 *
 * Nothing here is permanent: Cancel closes the box with nothing sent; a sent text is history, and one that did not go (texting switched
 * off, a failure) stays in the Conversation as a card with "Send now" and "Reject".
 */

import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { refreshHub } from "../lib/hubQueries";

export type TextTarget = "lead" | "account" | "job";

/** The longest text the box takes (the server refuses more). */
export const TEXT_BOX_MAX = 1000;

export function SendTextPanel({ target, id, block }: {
  target: TextTarget;
  id: string;
  /** Why the box is greyed (the server's sentence: no phone, or replied STOP); null when a text can go. */
  block: string | null;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The ONE id of the text being composed: made on the first press of Send and reused by every retry of it, so a lost answer never texts twice.
  const composeId = useRef<string | null>(null);

  const send = useMutation({
    mutationFn: () => {
      const clientMessageId = composeId.current ?? crypto.randomUUID();
      composeId.current = clientMessageId;
      return api.sendRecordText({ target, id, body: body.trim(), clientMessageId });
    },
    onSuccess: () => {
      composeId.current = null;
      setError(null);
      setBody("");
      setOpen(false);
      setNotice("Text sent.");
      refreshHub(queryClient);
    },
    onError: (err) => {
      setNotice(null);
      setError((err as Error).message);
      // A refused or failed text is recorded in the Conversation as "Not texted" with its reason.
      refreshHub(queryClient);
    },
  });

  const close = () => {
    setOpen(false);
    setBody("");
    setError(null);
    composeId.current = null;
  };

  if (!open) {
    return (
      <div>
        <button
          type="button"
          className="btn btn-secondary text-xs"
          disabled={Boolean(block)}
          title={block ?? "Send a text message to this customer's phone"}
          onClick={() => { setNotice(null); setOpen(true); }}
        >
          Text the customer
        </button>
        {block && <p className="mt-1 max-w-xs text-xs text-rce-muted">{block}</p>}
        {notice && <p className="mt-1 text-xs text-rce-success" role="status">{notice}</p>}
      </div>
    );
  }

  return (
    <form
      className="w-full space-y-2 rounded-lg border border-rce-border p-2"
      aria-label="Text the customer"
      onSubmit={(e) => { e.preventDefault(); if (body.trim() && !send.isPending) send.mutate(); }}
    >
      <label className="block text-xs font-medium text-rce-soft">
        Text message
        <textarea
          className="field mt-1"
          rows={3}
          maxLength={TEXT_BOX_MAX}
          value={body}
          onChange={(e) => { composeId.current = null; setBody(e.target.value); }}
        />
      </label>
      <p className="text-xs text-rce-muted">
        Goes to the phone on file from the Red Cedar number. The company name and the "Reply STOP" line are added for you, so leave them out.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" className="btn btn-primary text-xs" disabled={!body.trim() || send.isPending}>
          {send.isPending ? "Sending…" : "Send text"}
        </button>
        <button type="button" className="btn btn-secondary text-xs" onClick={close} disabled={send.isPending}>Cancel</button>
      </div>
      {error && <p className="text-xs text-red-700" role="alert">{error}</p>}
    </form>
  );
}
