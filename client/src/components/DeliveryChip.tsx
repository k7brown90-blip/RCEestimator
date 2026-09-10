/**
 * DeliveryChip — what actually became of the last email about a row.
 *
 * Kyle, 2026-09-09: *"I need the emails working, very few are actually getting through, this
 * is priority number one."* Customer email now leaves Resend-first with Gmail as the automatic
 * fallback, and Resend reports each message's fate by webhook. This chip is that report, next
 * to the bounce badge on Estimates rows, account estimate rows and invoice rows:
 *
 *   Delivered 5:12 PM               green — the receiver accepted it (Resend's word)
 *   Sent, awaiting delivery report  grey  — Resend took it; no event yet
 *   Sent via Gmail                  grey  — the fallback pipe; Gmail reports nothing
 *   Delayed                         amber — the receiver is deferring it
 *   Bounced / Complained            red   — reason on hover
 *   Not sent                        red   — neither pipe took it; error on hover
 */

import type { EmailLastDelivery } from "../lib/types";

function when(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return sameDay ? time : `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}

export function DeliveryChip({ delivery }: { delivery?: EmailLastDelivery | null }) {
  if (!delivery) return null;
  const d = delivery;
  const at = when(d.statusAt);

  let label: string;
  let tone: string;
  let title: string | undefined = `To ${d.to}`;
  switch (d.status) {
    case "delivered":
      label = `Delivered${at ? ` ${at}` : ""}`;
      tone = "bg-emerald-100 text-emerald-800";
      break;
    case "delayed":
      label = `Delayed${at ? ` ${at}` : ""}`;
      tone = "bg-amber-100 text-amber-800";
      title = `To ${d.to} — the receiver is deferring it; Resend keeps trying.`;
      break;
    case "bounced":
      label = `Bounced${at ? ` ${at}` : ""}`;
      tone = "bg-red-100 text-red-800";
      title = `To ${d.to}${d.error ? ` — ${d.error}` : ""}`;
      break;
    case "complained":
      label = `Complained${at ? ` ${at}` : ""}`;
      tone = "bg-red-100 text-red-800";
      title = `To ${d.to} — the recipient marked it as spam${d.error ? ` — ${d.error}` : ""}`;
      break;
    case "failed":
      label = "Not sent";
      tone = "bg-red-100 text-red-800";
      title = `To ${d.to}${d.error ? ` — ${d.error}` : ""}`;
      break;
    default:
      label = d.provider === "gmail" ? "Sent via Gmail" : "Sent, awaiting delivery report";
      tone = "bg-gray-100 text-gray-700";
      title = d.provider === "gmail"
        ? `To ${d.to} — Gmail reports nothing back; a bounce would show within ten minutes.`
        : `To ${d.to} — Resend accepted it; the delivered/bounced report usually lands within a minute.`;
  }

  return (
    <span className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-medium ${tone}`} title={title}>
      {label}
    </span>
  );
}
