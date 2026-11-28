import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { BounceBadge } from "./BounceBadge";
import { DeliveryChip } from "./DeliveryChip";
import { OpenDrawerButton } from "./drawers/OpenDrawerButton";
import { useDrawerParams } from "../lib/drawers";
import { api, openProtectedPdf } from "../lib/api";
import type { PbIssuedEstimate } from "../lib/types";
import { money } from "../lib/utils";
import { quotedRangeText } from "../../../shared/quoteMoney";

/**
 * Everything quoted at THIS property — the estimate half of Kyle's funnel, on the Property page.
 *
 * Kyle, 2026-10-24: "I would like the invoices, and estimates to be organized on the property page
 * not on the account page." This list used to be `AccountEstimates` on the account page, with an
 * address <select>; with the property page as its home the address is the page, so the select is
 * gone. Same server read (`GET /accounts/:id/estimates?serviceAddressId=`), same rows, same
 * drawer — only the home changed.
 */
/**
 * ONE CARD PER ESTIMATE NUMBER (Kyle, 2026-11-27, screenshot of one number listed five times:
 * "see how each draft creates a new document. I am tired of it").
 *
 * The server sends every revision. The card is the NEWEST revision of each number - the one the
 * customer's link opens and the one to act on - and the ones it replaced fold under it as "Earlier
 * revisions (n)". They are not dropped: each keeps its Open (the drawer, where Delete lives) and
 * its View, because nothing the app creates may be left without a way out. The Estimates page
 * already files superseded rows behind a toggle (EstimatesPage classify); this matches it.
 *
 * Newest = the highest revision present. (After a later revision is deleted, the one before it is
 * live again - so "has no supersededBy" can be true of two rows, and the revision number cannot.)
 * Order of the cards is the server's: the first row seen for a number places its card.
 */
export function groupByEstimateNumber<T extends { number: string; revision: number }>(
  rows: readonly T[],
): Array<{ live: T; earlier: T[] }> {
  const byNumber = new Map<string, T[]>();
  for (const row of rows) {
    const group = byNumber.get(row.number);
    if (group) group.push(row);
    else byNumber.set(row.number, [row]);
  }
  return [...byNumber.values()].map((group) => {
    const newestFirst = [...group].sort((a, b) => b.revision - a.revision);
    return { live: newestFirst[0], earlier: newestFirst.slice(1) };
  });
}

export function PropertyEstimates({
  accountId,
  propertyId,
}: {
  accountId: string;
  propertyId: string;
}) {
  const navigate = useNavigate();
  const drawers = useDrawerParams();
  /*
    THE ROW SHOWS; THE DRAWER ACTS (2026-09-21, drawers plan Phase 6). Delete (unsigned — Kyle,
    2026-08-22: "I need a way to delete the duplicates"), Void (signed, 2026-09-17 — cancels the
    job, says what is left to refund and cancel by hand), Copy to new (Kyle, 2026-08-31) and
    Resend to a chosen address (Kyle, 2026-08-25) all live in the estimate's drawer
    (`EstimateDrawer`), which Open raises over this page. They used to be buttons on this row
    too, shipped beside the drawer in build #2; Kyle chose the drawer. What stays on the row is
    Kyle's 2026-08-20 pair — View (the company PDF) and Edit (a draft, in the builder) — and
    the Property page's "Create New Estimate" door above this list.
  */
  const { data } = useQuery({
    queryKey: ["account-estimates", accountId, propertyId],
    queryFn: () => api.accountEstimates(accountId, propertyId),
  });
  const rows = data?.estimates ?? [];
  const groups = groupByEstimateNumber<PbIssuedEstimate>(rows);

  return (
    <section className="card mb-5 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">
          Estimates <span className="text-sm font-normal text-rce-muted">({groups.length})</span>
        </h2>
      </div>

      {rows.length === 0 && (
        <p className="mt-3 text-sm text-rce-muted">
          Nothing quoted at this address yet.
        </p>
      )}

      {/*
        ── VIEW AND EDIT, NOT ONE OR THE OTHER (Kyle, 2026-08-20) ────────────────────────────────

        "Now we can add an edit button for estimates that are unfinished. There should be a view
         button that does exactly what clicking on the estimate does now and an edit button that
         loads this into the estimate builder to finalize and send to the customer."

        View is the old behaviour, unchanged: the company PDF, because an issued estimate is a
        record and the place to look at one is the page it prints as.

        Edit reopens the DRAFT this was issued from, in the builder, on the review tab — where he
        left off.

        ── WHY THE ROW IS NO LONGER ITSELF A BUTTON ──────────────────────────────────────────────

        It was, and a button inside a button is invalid HTML that browsers resolve by dropping one
        of them. The row is a plain container now and View carries what the row used to do.

        ── AND WHY EDIT ONLY APPEARS ON A DRAFT ──────────────────────────────────────────────────

        Kyle said "unfinished", and draft is the only status that means it: nothing has gone to the
        customer yet, so reopening the builder changes a document nobody has seen.

        Once it is sent, viewed, or signed, the customer is holding a number. Editing the draft
        underneath it would silently change what they were quoted, so those need a REVISION or a
        change order — a different path with its own paper trail, which this button deliberately
        does not pretend to be.
      */}
      <div className="mt-3 space-y-2">
        {groups.map(({ live: e, earlier }) => {
          const unfinished = e.status === "draft";
          return (
            <div
              key={e.id}
              className="rounded-lg border border-rce-border/70 p-3"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="break-words font-medium">{e.title}</p>
                  <p className="text-xs text-rce-soft">
                    {e.number}
                    {e.revision > 1 ? ` rev ${e.revision}` : ""} ·{" "}
                    {/* The FROZEN text, not a live lookup — this is what the signed document says. */}
                    {e.serviceAddress ?? "address missing"}
                  </p>
                  <p className="text-xs uppercase tracking-wide text-rce-muted">{e.status}</p>
                {/* Archived (Kyle, 2026-10-01): put away, with the reason, wherever the row is shown. */}
                {e.archivedAt && (
                  <p className="text-xs font-semibold text-rce-soft">
                    Archived {new Date(e.archivedAt).toLocaleDateString()}{e.archivedReason ? ` — ${e.archivedReason}` : ""}
                  </p>
                )}
                {/* Kyle, 2026-09-09: "My emails are not getting to the clients" — when Gmail
                    reported this estimate's email undeliverable, say so here, with the reason. */}
                {(e.lastBounceAt || e.lastDelivery) && (
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    {e.lastBounceAt && <BounceBadge at={e.lastBounceAt} reason={e.lastBounceReason} />}
                    {/* The last email's delivery report (Kyle, 2026-09-09: Resend first, Gmail fallback). */}
                    <DeliveryChip delivery={e.lastDelivery} />
                  </div>
                )}
                {/*
                  Kyle, 2026-08-22: "Is there any way to know if our emails have been read?"
                  For an estimate the honest signal already exists — the customer either opened
                  the page with the price on it or they did not — and it was recorded without
                  being shown. Now it is shown. A view within ~2 minutes of the send is flagged:
                  corporate mail scanners prefetch links, and that "view" is usually a machine.
                */}
                {e.sentAt && !e.signedAt && (
                  e.firstViewedAt ? (
                    <p className="text-xs font-semibold text-green-700">
                      Viewed {new Date(e.firstViewedAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                      {new Date(e.firstViewedAt).getTime() - new Date(e.sentAt).getTime() < 120_000
                        ? " · seconds after sending — possibly a mail scanner"
                        : ""}
                    </p>
                  ) : (
                    <p className="text-xs text-amber-800">
                      Sent {new Date(e.sentAt).toLocaleDateString([], { month: "short", day: "numeric" })} — not opened yet
                    </p>
                  )
                )}
                </div>
                {/* The billed figure once signed — the row and the document must agree (2026-08-22).
                    With a home-warranty claim (2026-09-09) it is the homeowner share, and the
                    warranty company's credit is shown beside it so the numbers read right. */}
                <div className="shrink-0 text-right">
                  <p className="font-semibold">{e.quotedRange ? quotedRangeText(e.quotedRange, money) : money(e.billedTotal ?? e.total)}</p>
                  {/* A change order joins its invoice (Kyle, 2026-09-20) — say which one. */}
                  {e.changeOrderForId && (
                    <p className="text-[11px] text-rce-soft">change order{e.changeOrderForNumber ? ` → invoice ${e.changeOrderForNumber}` : ""}</p>
                  )}
                  {(e.warrantyCovered ?? 0) > 0 && (
                    <p className="text-[11px] text-green-700">
                      warranty ${(e.warrantyCovered ?? 0).toFixed(2)}
                      {e.warranty ? ` · ${e.warranty.company} claim ${e.warranty.claimNumber}` : ""}
                      {/* The receivable (Kyle, 2026-09-10): has the warranty company paid its share yet? */}
                      {e.signedAt && (
                        (e.warrantyPaid ?? 0) >= (e.warrantyCovered ?? 0) - 0.01
                          ? <span className="ml-1 rounded bg-emerald-100 px-1 text-emerald-800">{e.warranty?.company ?? "warranty"} paid</span>
                          : <span className="ml-1 rounded bg-amber-100 px-1 text-amber-900">{e.warranty?.company ?? "warranty"} unpaid{(e.warrantyPaid ?? 0) > 0 ? ` (${money(e.warrantyPaid ?? 0)} in)` : ""}</span>
                      )}
                    </p>
                  )}
                </div>
              </div>

              <div className="mt-2 flex flex-wrap gap-2">
                {/* The estimate's drawer (2026-09-20) — the same actions, over this page. */}
                <OpenDrawerButton kind="estimate" id={e.id} onOpen={drawers.open} label="Open" className="btn btn-secondary flex-1 text-sm" />
                <button
                  type="button"
                  onClick={() => void openProtectedPdf(`/issued-estimates/${e.id}/pdf?audience=company`)}
                  className="btn btn-secondary flex-1 text-sm"
                >
                  View
                </button>
                {/*
                  Kyle, 2026-11-27 (debug report on a signed estimate): "She signed but all I get is the open and
                  view. I cannot get to a place to process payment." A signed, live estimate's card opens the
                  SAME invoice drawer and Take payment card as the estimate drawer's button - one tool, a second
                  door where Kyle is standing. A change order pays on its root invoice (D1, EstimateDrawer).
                */}
                {e.signedAt && e.status !== "void" && e.status !== "lost" && (
                  <OpenDrawerButton
                    kind="invoice"
                    id={e.changeOrderForId ?? e.id}
                    onOpen={drawers.open}
                    label="Invoice & payment"
                    className="btn btn-primary flex-1 text-sm"
                  />
                )}
                {unfinished && (
                  <button
                    type="button"
                    onClick={() =>
                      navigate(
                        `/estimate-intake?account=${encodeURIComponent(e.customerId)}` +
                          `&address=${encodeURIComponent(e.serviceAddressId)}` +
                          `&draft=${encodeURIComponent(e.draftId)}&tab=review`,
                      )
                    }
                    className="btn btn-primary flex-1 text-sm"
                  >
                    Edit
                  </button>
                )}
              </div>

              {/* The revisions this one replaced - folded, each with its own Open and View. */}
              {earlier.length > 0 && (
                <details className="mt-2 rounded border border-rce-border/50 p-2">
                  <summary className="cursor-pointer text-xs font-medium text-rce-muted">
                    Earlier revisions ({earlier.length})
                  </summary>
                  <p className="mt-1 text-[11px] text-rce-soft">
                    Replaced by rev {e.revision}. Their customer links no longer open. Open one to delete it.
                  </p>
                  <div className="mt-2 space-y-2">
                    {earlier.map((old) => (
                      <div key={old.id} className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-xs text-rce-soft">
                          rev {old.revision} · <span className="uppercase tracking-wide">{old.status}</span> ·{" "}
                          {old.quotedRange ? quotedRangeText(old.quotedRange, money) : money(old.billedTotal ?? old.total)} ·{" "}
                          {new Date(old.createdAt).toLocaleDateString()}
                        </p>
                        <div className="flex gap-2">
                          <OpenDrawerButton kind="estimate" id={old.id} onOpen={drawers.open} label={`Open rev ${old.revision}`} className="btn btn-secondary text-xs" />
                          <button
                            type="button"
                            onClick={() => void openProtectedPdf(`/issued-estimates/${old.id}/pdf?audience=company`)}
                            className="btn btn-secondary text-xs"
                          >
                            View rev {old.revision}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
