/**
 * THE FOUR-PHASE FUNNEL, pinned with a worked example (Kyle, 2026-09-20).
 *
 * "We have to recognize the difference between winning a job and gaining an opportunity...
 * There really is 4 distinct phases to the lead flow to client retention process."
 *
 * Until this build the Dashboard's headline "Win Rate" was `won leads / (won + lost leads)` —
 * phase 1 data wearing a phase 3 label. Every measure below therefore asserts BOTH its numerator
 * and its denominator; a rate on its own is exactly how the old number went unquestioned.
 *
 * The example, all of it inside one month of 2031 so no other test file's rows can reach it:
 *
 *   PHASE 1  8 leads arrive (5 Google, 2 Yelp, 1 untagged) + 1 wrong number that is not a lead
 *            at all + 1 lead on the TEST account that must never be counted.
 *            4 become opportunities, 2 are lost, 2 are still open.
 *   PHASE 2  3 of those 8 leads were quoted.
 *   PHASE 3  5 estimate DOCUMENTS are first issued in the month — one signed, one revised twice
 *            and then lost, one still sent, one never sent (draft) and one void. The win rate is
 *            1 of 3: the draft and the void are outside it, the LOST one is inside it.
 *   PHASE 4  lifetime and unwindowed, so it is asserted as a DELTA against a report taken before
 *            any of this existed. `fileParallelism: false` makes that safe.
 *
 * It also pins the attribution rule that phase 2 depends on: a quote with no lead link and no
 * visit link is attributed to the LATEST lead on its account at or before the quote, ranked over
 * every lead on the account — not only the ones inside the window. Ranking in-window leads alone
 * hands a March lead the credit for a quote an April lead produced.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma";
import { getFunnelReport, type FunnelReport, type FunnelRange } from "../src/services/leadFunnel";
import { collectedByCustomer, lifetimeCollectedFor } from "../src/services/lifetimeCollected";
import { ensurePriceBookGates, HD_SUPPLIER_ID } from "./helpers/priceBookFixture";

const MARK = "FUNNEL31";
const at = (iso: string) => new Date(`${iso}T12:00:00.000Z`);

/** March 2031 — far from every other fixture in the shared test database. */
const RANGE: FunnelRange = {
  start: new Date("2031-03-01T00:00:00.000Z"),
  end: new Date("2031-03-31T23:59:59.999Z"),
  startDate: "2031-03-01",
  endDate: "2031-03-31",
};

const accounts: Record<string, string> = {};
const leads: Record<string, string> = {};
let draftId: string;
let baseline: FunnelReport;
let report: FunnelReport;

async function makeAccount(key: string, data: { platform?: string | null; email?: string | null; isTestAccount?: boolean }) {
  const customer = await prisma.customer.create({
    data: {
      name: `${MARK} ${key}`,
      email: data.email ?? null,
      platform: data.platform ?? null,
      isTestAccount: data.isTestAccount ?? false,
    },
  });
  accounts[key] = customer.id;
  const property = await prisma.property.create({
    data: {
      customerId: customer.id, name: `${MARK} ${key} house`, addressLine1: `${key} Funnel Way`,
      city: "Smyrna", state: "TN", postalCode: "37167",
    },
  });
  return { customerId: customer.id, propertyId: property.id };
}

async function makeLead(key: string, data: {
  platform?: string | null; status: string; leadStatus: string; lostReason?: string | null;
  callType?: string | null; customerId?: string | null; createdAt: Date;
}) {
  const lead = await prisma.lead.create({
    data: {
      name: `${MARK} ${key}`,
      source: "web",
      platform: data.platform ?? null,
      status: data.status,
      leadStatus: data.leadStatus,
      lostReason: data.lostReason ?? null,
      callType: data.callType ?? null,
      customerId: data.customerId ?? null,
      createdAt: data.createdAt,
    },
  });
  leads[key] = lead.id;
  return lead.id;
}

async function makeEstimate(input: {
  number: string; revision?: number; status: string; createdAt: Date;
  customerId: string; serviceAddressId: string; leadId?: string | null; lostReason?: string | null;
  total?: number;
}) {
  return prisma.issuedEstimate.create({
    data: {
      number: input.number,
      revision: input.revision ?? 1,
      status: input.status,
      token: `${MARK}-${input.number}-${input.revision ?? 1}`,
      draftId,
      customerId: input.customerId,
      serviceAddressId: input.serviceAddressId,
      customerName: `${MARK} customer`,
      title: `${MARK} ${input.number}`,
      workSubtotal: input.total ?? 1000,
      total: input.total ?? 1000,
      leadId: input.leadId ?? null,
      lostReason: input.lostReason ?? null,
      createdAt: input.createdAt,
    },
  });
}

beforeAll(async () => {
  await ensurePriceBookGates();
  // Taken BEFORE anything below exists: phase 4 is lifetime, so it is only assertable as a delta.
  baseline = await getFunnelReport(prisma, RANGE);

  const draft = await prisma.priceBookDraftEstimate.create({
    data: { title: `${MARK} draft`, supplierId: HD_SUPPLIER_ID },
  });
  draftId = draft.id;

  const a = await makeAccount("A", { platform: "google", email: "funnel31-a@example.com" });
  const b = await makeAccount("B", { platform: "google", email: "funnel31-b@example.com" });
  const c = await makeAccount("C", { platform: "yelp", email: null });
  const d = await makeAccount("D", { platform: null, email: null });
  const e = await makeAccount("E", { platform: "google", email: "funnel31-e@example.com" });
  const t = await makeAccount("T", { platform: "google", email: "funnel31-t@example.com", isTestAccount: true });

  // B unsubscribed; C and D have no email at all.
  await prisma.emailSuppression.create({ data: { email: "funnel31-b@example.com" } });

  // ── PHASE 1: who arrived in March 2031 ──────────────────────────────────────────────────
  await makeLead("G1", { platform: "google", status: "converted", leadStatus: "won", customerId: a.customerId, createdAt: at("2031-03-02") });
  await makeLead("G2", { platform: "google", status: "converted", leadStatus: "won", customerId: b.customerId, createdAt: at("2031-03-03") });
  await makeLead("G3", { platform: "google", status: "lost", leadStatus: "lost", lostReason: "price", createdAt: at("2031-03-04") });
  await makeLead("G4", { platform: "google", status: "new", leadStatus: "new", createdAt: at("2031-03-05") });
  await makeLead("Y1", { platform: "yelp", status: "converted", leadStatus: "won", customerId: c.customerId, createdAt: at("2031-03-06") });
  await makeLead("Y2", { platform: "yelp", status: "lost", leadStatus: "lost", lostReason: "trust", createdAt: at("2031-03-07") });
  await makeLead("U1", { platform: null, status: "new", leadStatus: "new", createdAt: at("2031-03-08") });
  await makeLead("W1", { platform: "google", status: "converted", leadStatus: "won", customerId: e.customerId, createdAt: at("2031-03-09") });
  // Not a lead at all — shown on the card, never in either half of the rate.
  await makeLead("N1", { platform: "google", status: "lost", leadStatus: "lost", callType: "wrong_number", createdAt: at("2031-03-10") });
  // The practice account. EXCLUDE_TEST_ACCOUNT must hold in every new figure.
  await makeLead("T1", { platform: "google", status: "converted", leadStatus: "won", customerId: t.customerId, createdAt: at("2031-03-11") });
  // On account E but OUTSIDE the window — the ranking lead for the May quote below.
  await makeLead("W2", { platform: "google", status: "new", leadStatus: "new", customerId: e.customerId, createdAt: at("2031-04-05") });

  // ── PHASE 3: the estimate documents ─────────────────────────────────────────────────────
  // Signed — the only contracted quote in the window.
  await makeEstimate({ number: `${MARK}-1001`, status: "signed", createdAt: at("2031-03-12"), customerId: a.customerId, serviceAddressId: a.propertyId, leadId: leads.G1, total: 1200 });
  // ONE document, two revisions: dated from the first, judged at the latest. Latest is LOST.
  await makeEstimate({ number: `${MARK}-1002`, revision: 1, status: "sent", createdAt: at("2031-03-13"), customerId: b.customerId, serviceAddressId: b.propertyId, leadId: leads.G2 });
  await makeEstimate({ number: `${MARK}-1002`, revision: 2, status: "lost", lostReason: "price", createdAt: at("2031-03-20"), customerId: b.customerId, serviceAddressId: b.propertyId, leadId: leads.G2 });
  // Still out.
  await makeEstimate({ number: `${MARK}-1003`, status: "sent", createdAt: at("2031-03-14"), customerId: c.customerId, serviceAddressId: c.propertyId, leadId: leads.Y1 });
  // Never presented, and a dead document: both outside the rate, both reported.
  await makeEstimate({ number: `${MARK}-1004`, status: "draft", createdAt: at("2031-03-15"), customerId: d.customerId, serviceAddressId: d.propertyId });
  await makeEstimate({ number: `${MARK}-1005`, status: "void", createdAt: at("2031-03-16"), customerId: d.customerId, serviceAddressId: d.propertyId });
  // Signed BEFORE the window — out of phase 3, but it makes account A a repeat account.
  await makeEstimate({ number: `${MARK}-0999`, status: "signed", createdAt: at("2031-02-10"), customerId: a.customerId, serviceAddressId: a.propertyId, total: 800 });
  // The test account's signed quote — never counted anywhere.
  await makeEstimate({ number: `${MARK}-1099`, status: "signed", createdAt: at("2031-03-17"), customerId: t.customerId, serviceAddressId: t.propertyId, total: 5000 });
  // No lead link, no visit link, issued in MAY: the account fallback must rank W2 (April) and,
  // because W2 is outside the window, credit NOBODY — least of all W1.
  await makeEstimate({ number: `${MARK}-1007`, status: "sent", createdAt: at("2031-05-10"), customerId: e.customerId, serviceAddressId: e.propertyId });

  // ── PHASE 4: the money actually collected ───────────────────────────────────────────────
  await prisma.payment.createMany({
    data: [
      { customerId: a.customerId, amount: 1000, method: "stripe", status: "paid", payer: "customer", paidAt: at("2031-03-25") },
      { customerId: a.customerId, amount: 500, method: "check", status: "paid", payer: "warranty", paidAt: at("2031-03-26") },
      { customerId: c.customerId, amount: 250, method: "cash", status: "paid", payer: "customer", paidAt: at("2031-03-27") },
      // Never money: a retired 3% "discount" credit, an unpaid row, and the test account.
      { customerId: c.customerId, amount: 100, method: "discount", status: "paid", payer: "customer", paidAt: at("2031-03-28") },
      { customerId: b.customerId, amount: 900, method: "stripe", status: "pending", payer: "customer", paidAt: at("2031-03-29") },
      { customerId: t.customerId, amount: 9999, method: "stripe", status: "paid", payer: "customer", paidAt: at("2031-03-30") },
    ],
  });

  report = await getFunnelReport(prisma, RANGE);
});

afterAll(async () => {
  const ids = Object.values(accounts);
  await prisma.payment.deleteMany({ where: { customerId: { in: ids } } });
  await prisma.issuedEstimate.deleteMany({ where: { customerId: { in: ids } } });
  await prisma.lead.deleteMany({ where: { name: { startsWith: MARK } } });
  await prisma.priceBookDraftEstimate.deleteMany({ where: { id: draftId } });
  await prisma.property.deleteMany({ where: { customerId: { in: ids } } });
  await prisma.customer.deleteMany({ where: { id: { in: ids } } });
  await prisma.emailSuppression.deleteMany({ where: { email: { startsWith: "funnel31-" } } });
});

describe("phase 1 — lead to account (the OPPORTUNITY)", () => {
  it("counts opportunities over leads, not wins over losses", () => {
    expect(report.opportunity.leads).toBe(8);
    expect(report.opportunity.opportunities).toBe(4);
    expect(report.opportunity.lost).toBe(2);
    expect(report.opportunity.open).toBe(2);
    // 4 / 8 — the denominator is every lead that arrived, not just the closed ones.
    expect(report.opportunity.rate).toBe(50);
  });

  it("keeps a wrong number out of both halves and reports it separately", () => {
    expect(report.opportunity.notLeads).toBe(1);
    expect(report.opportunity.leads + report.opportunity.notLeads).toBe(9);
  });

  it("never counts the test account", () => {
    // 10 leads with a customer or not were created in the window; the practice one is not here.
    const google = report.opportunity.byPlatform.find((row) => row.platform === "google")!;
    expect(google.leads).toBe(5);
    expect(google.opportunities).toBe(3);
  });

  it("reads by platform, with an untagged lead as 'unknown' rather than dropped", () => {
    const byPlatform = Object.fromEntries(report.opportunity.byPlatform.map((row) => [row.platform, row]));
    expect(byPlatform.google).toEqual({ platform: "google", leads: 5, opportunities: 3, lost: 1, quoted: 2, opportunityRate: 60 });
    expect(byPlatform.yelp).toEqual({ platform: "yelp", leads: 2, opportunities: 1, lost: 1, quoted: 1, opportunityRate: 50 });
    expect(byPlatform.unknown).toEqual({ platform: "unknown", leads: 1, opportunities: 0, lost: 0, quoted: 0, opportunityRate: 0 });
    // Every lead is in exactly one platform row.
    expect(report.opportunity.byPlatform.reduce((sum, row) => sum + row.leads, 0)).toBe(8);
  });

  it("reports why a LEAD was lost, which is not why a quote was lost", () => {
    expect(report.opportunity.lostReasons).toEqual({ price: 1, trust: 1 });
  });
});

describe("phase 2 — lead to estimate", () => {
  it("counts the leads we actually got in front of", () => {
    // G1, G2 and Y1 each have a presented quote. G3, G4, Y2, U1 and W1 do not.
    expect(report.quoted.quoted).toBe(3);
    expect(report.quoted.leads).toBe(8);
    expect(report.quoted.rate).toBe(38); // 3/8 = 37.5
  });

  it("does not credit an in-window lead for a quote a later lead produced", () => {
    // The May quote on account E has no lead link; the closest lead before it is W2 (April,
    // outside the window), so nobody is credited — least of all W1, which is in the window.
    const google = report.opportunity.byPlatform.find((row) => row.platform === "google")!;
    expect(google.quoted).toBe(2); // G1 and G2 only — never W1.
  });
});

describe("phase 3 — estimate to job: THE win rate", () => {
  it("is contracted over issued, counting documents and not revisions", () => {
    expect(report.winRate.contracted).toBe(1);
    expect(report.winRate.lost).toBe(1);
    expect(report.winRate.open).toBe(1);
    expect(report.winRate.issued).toBe(3);
    expect(report.winRate.rate).toBe(33);
  });

  it("keeps LOST in the denominator and VOID out of it", () => {
    // Remove the lost quote from the denominator and the rate would read 50%. It does not.
    expect(report.winRate.issued).toBe(report.winRate.contracted + report.winRate.lost + report.winRate.open);
    expect(report.winRate.voided).toBe(1);
    expect(report.winRate.unsent).toBe(1);
  });

  it("windows on the FIRST issue, so a quote from before the month stays out", () => {
    // FUNNEL31-0999 is signed and would otherwise make this 2 of 4.
    expect(report.winRate.contracted).toBe(1);
  });

  it("reports why a QUOTE was lost, separately from the lead reasons", () => {
    expect(report.winRate.lostReasons).toEqual({ price: 1 });
    // Same word, different populations: the lead list also has "trust", this one does not.
    expect(report.winRate.lostReasons.trust).toBeUndefined();
  });
});

describe("phase 4 — account to repeat", () => {
  const delta = (pick: (r: FunnelReport) => number) => pick(report) - pick(baseline);

  it("counts money COLLECTED, never invoiced, and never the retired discount rows", () => {
    // 1000 customer + 500 warranty on A, 250 on C. Not C's $100 discount credit, not B's
    // pending $900, not the practice account's $9,999.
    expect(delta((r) => r.retention.lifetimeCollected)).toBe(1750);
    expect(delta((r) => r.retention.payingAccounts)).toBe(2);
  });

  it("calls an account a repeat when it has signed twice", () => {
    // A signed FUNNEL31-0999 and FUNNEL31-1001. C signed nothing; its quote is still out.
    expect(delta((r) => r.retention.repeatAccounts)).toBe(1);
  });

  it("says who the newsletter can actually reach", () => {
    expect(delta((r) => r.retention.accounts)).toBe(5); // A, B, C, D, E — never T.
    expect(delta((r) => r.retention.newsletter.reachable)).toBe(2); // A and E.
    expect(delta((r) => r.retention.newsletter.unsubscribed)).toBe(1); // B.
    expect(delta((r) => r.retention.newsletter.noEmail)).toBe(2); // C and D.
  });
});

describe("one definition of lifetime collected", () => {
  it("answers the same for one account as the funnel does for all of them", async () => {
    const a = await lifetimeCollectedFor(prisma, accounts.A);
    expect(a.collected).toBe(1500);
    expect(a.customerPaid).toBe(1000);
    expect(a.warrantyPaid).toBe(500);
    expect(a.paymentCount).toBe(2);

    const many = await collectedByCustomer(prisma, [accounts.A, accounts.B, accounts.C]);
    expect(many.get(accounts.A)!.collected).toBe(1500);
    expect(many.get(accounts.C)!.collected).toBe(250); // the discount row is not money
    expect(many.get(accounts.B)).toBeUndefined();      // pending is not collected
  });

  it("never reports the practice account", async () => {
    expect((await lifetimeCollectedFor(prisma, accounts.T)).collected).toBe(0);
  });
});
