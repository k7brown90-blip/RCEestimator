/**
 * One hook per single-record read that BOTH a page and a drawer need.
 *
 * tests/queryKeyCollisions.test.ts compares every `useQuery` call site by key AND by the text of
 * its `queryFn`: two call sites under one key with differently-spelled fetches read as two
 * response shapes under one key — the bug that blanked the account page on 2026-08-19. A drawer
 * re-hosting a page's record is exactly that risk, so the read is written once here and both
 * surfaces call the hook. (The keys themselves are unchanged from the pages that owned them.)
 */

import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

/** One lead — LeadFormPage's edit read, and the lead drawer's. */
export function useLead(leadId: string | undefined) {
  return useQuery({
    queryKey: ["leads", { leadId }],
    queryFn: () => api.lead(leadId!),
    enabled: Boolean(leadId),
  });
}

/** One visit (a job) — VisitWorkspacePage's read, and the job drawer's. */
export function useVisit(visitId: string) {
  return useQuery({
    queryKey: ["visit", visitId],
    queryFn: () => api.visit(visitId),
    enabled: Boolean(visitId),
  });
}

/** One issued estimate in the account-row projection (no capability token — PUNCHLIST B4). */
export function useEstimateRecord(estimateId: string) {
  return useQuery({
    queryKey: ["estimate-record", estimateId],
    queryFn: () => api.estimateRecord(estimateId),
  });
}

/** One receipt, for the receipt drawer. */
export function useReceiptRecord(receiptId: string) {
  return useQuery({
    queryKey: ["receipt", receiptId],
    queryFn: () => api.receipt(receiptId),
  });
}
