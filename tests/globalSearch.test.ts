/**
 * Global search — GET /search (2026-09-20, drawers plan Phase 5).
 *
 * Pins, in order: the ranking (a whole number first, then a prefix, then text, then a fragment;
 * within a rank the account before the address before the lead, job, estimate, P.O.); that a
 * result carries the drawer to open (or the account page's href); the per-kind cap and its
 * `more` flag; that the practice account never surfaces on ANY kind; that no capability token
 * (PUNCHLIST B4) is anywhere in the payload; and that the route is not public.
 *
 * Every row here carries the marker "Zqsearch"/"Zqcedar" so it cannot collide with other files'
 * fixtures in the shared test database, and every row is deleted in afterAll.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { prisma } from "../src/lib/prisma";
import { app } from "../src/app";
import { isPublicRoute } from "../src/middleware/publicRoutes";
import { addLine, createDraft } from "../src/services/atomicEstimateService";
import { graduateDraft } from "../src/services/issuedEstimateService";
import { phoneNeedle, rankResults, type SearchResult } from "../src/services/globalSearch";
import { deleteAtomics, ensurePriceBookGates, quotableAtomic, seedAtomics } from "./helpers/priceBookFixture";

const ATOMIC = "SRCH01";
const PO_NUMBER = "PO-2099-0042";
const PO_NUMBER_PRACTICE = "PO-2099-0043";

let real = { customerId: "", propertyId: "", visitId: "", draftId: "", estimateId: "", estimateNumber: "", poId: "", leadId: "" };
let practice = { customerId: "", propertyId: "", visitId: "", draftId: "", estimateId: "", poId: "", leadId: "" };
const manyLeadIds: string[] = [];

async function issue(customerId: string, propertyId: string, visitId: string, title: string) {
  const draft = await createDraft(prisma, { title, supplierId: "HD", visitId });
  await addLine(prisma, draft.id, { itemId: ATOMIC, quantity: 1, quantitySource: "COUNT" });
  const graduated = await graduateDraft(prisma, { draftId: draft.id, accountId: customerId, serviceAddressId: propertyId });
  if (!graduated.ok) throw new Error("graduation failed");
  const est = await prisma.issuedEstimate.findUniqueOrThrow({ where: { id: graduated.estimateId }, select: { number: true } });
  return { draftId: draft.id, estimateId: graduated.estimateId, number: est.number };
}

beforeAll(async () => {
  await ensurePriceBookGates();
  await seedAtomics([quotableAtomic(ATOMIC)]);

  // ── The real account: one of everything ──
  const customer = await prisma.customer.create({
    data: { name: "Zqsearch Godwin", email: "zqsearch-godwin@example.com", phone: "(615) 555-0142" },
  });
  const property = await prisma.property.create({
    data: { customerId: customer.id, name: "Home", addressLine1: "44 Zqcedar Ln", city: "Smyrna", state: "TN", postalCode: "37167" },
  });
  const visit = await prisma.visit.create({
    data: {
      customerId: customer.id, propertyId: property.id, mode: "onsite", purpose: "Zqsearch panel job",
      jobType: "Panel Upgrade", status: "scheduled", scheduledStart: new Date("2026-10-02T14:00:00.000Z"),
    },
  });
  const issued = await issue(customer.id, property.id, visit.id, "Zqsearch panel work");
  const po = await prisma.purchaseOrder.create({
    data: { number: PO_NUMBER, purpose: "truck_stock", destinationType: "truck", supplier: "Zqsearch Supply", status: "open", openedBy: "owner", jobId: visit.id },
  });
  const lead = await prisma.lead.create({
    data: { name: "Zqsearch Godwin (lead)", phone: "615-555-0142", address: "44 Zqcedar Ln, Smyrna, TN 37167", source: "phone", status: "new" },
  });
  real = { customerId: customer.id, propertyId: property.id, visitId: visit.id, draftId: issued.draftId, estimateId: issued.estimateId, estimateNumber: issued.number, poId: po.id, leadId: lead.id };

  // ── The practice account: the same names and address, and it must never surface ──
  const tCustomer = await prisma.customer.create({
    data: { name: "Zqsearch Godwin practice", email: "zqsearch-practice@example.com", phone: "(615) 555-0142", isTestAccount: true },
  });
  const tProperty = await prisma.property.create({
    data: { customerId: tCustomer.id, name: "Home", addressLine1: "44 Zqcedar Ln", city: "Smyrna", state: "TN", postalCode: "37167" },
  });
  const tVisit = await prisma.visit.create({
    data: { customerId: tCustomer.id, propertyId: tProperty.id, mode: "onsite", purpose: "Zqsearch practice job", status: "scheduled" },
  });
  const tIssued = await issue(tCustomer.id, tProperty.id, tVisit.id, "Zqsearch panel work");
  const tPo = await prisma.purchaseOrder.create({
    data: { number: PO_NUMBER_PRACTICE, purpose: "truck_stock", destinationType: "truck", supplier: "Zqsearch Supply", status: "open", openedBy: "owner", jobId: tVisit.id },
  });
  const tLead = await prisma.lead.create({
    data: { name: "Zqsearch Godwin practice lead", phone: "615-555-0142", address: "44 Zqcedar Ln, Smyrna, TN 37167", source: "phone", status: "new", customerId: tCustomer.id },
  });
  practice = { customerId: tCustomer.id, propertyId: tProperty.id, visitId: tVisit.id, draftId: tIssued.draftId, estimateId: tIssued.estimateId, poId: tPo.id, leadId: tLead.id };

  // ── Seven leads for the cap ──
  for (let i = 1; i <= 7; i++) {
    const l = await prisma.lead.create({ data: { name: `Zqsearchmany lead ${i}`, source: "manual", status: "new" } });
    manyLeadIds.push(l.id);
  }
});

afterAll(async () => {
  await prisma.purchaseOrder.deleteMany({ where: { id: { in: [real.poId, practice.poId] } } });
  await prisma.lead.deleteMany({ where: { id: { in: [real.leadId, practice.leadId, ...manyLeadIds] } } });
  for (const p of [real, practice]) {
    await prisma.issuedEstimateEvent.deleteMany({ where: { estimateId: p.estimateId } });
    await prisma.issuedEstimateLine.deleteMany({ where: { estimateId: p.estimateId } });
    await prisma.issuedEstimate.deleteMany({ where: { id: p.estimateId } });
    await prisma.priceBookDraftLine.deleteMany({ where: { draftId: p.draftId } });
    await prisma.priceBookDraftQuestion.deleteMany({ where: { draftId: p.draftId } });
    await prisma.priceBookDraftEstimate.deleteMany({ where: { id: p.draftId } });
    await prisma.visit.deleteMany({ where: { customerId: p.customerId } });
    await prisma.property.deleteMany({ where: { customerId: p.customerId } });
    await prisma.customer.deleteMany({ where: { id: p.customerId } });
  }
  await deleteAtomics([ATOMIC]);
});

const search = (q: string, per?: number) =>
  request(app).get("/search").query(per ? { q, per } : { q });

const ids = (body: { results: SearchResult[] }) => body.results.map((r) => r.id);

describe("GET /search — numbers first", () => {
  it("an exact P.O. number is the first result, opens the P.O. drawer, and the practice P.O. is absent", async () => {
    const res = await search(PO_NUMBER);
    expect(res.status).toBe(200);
    const first = res.body.results[0];
    expect(first.kind).toBe("po");
    expect(first.id).toBe(real.poId);
    expect(first.match).toBe("number");
    expect(first.drawer).toEqual({ kind: "po", id: real.poId });
    expect(first.href).toBeNull();
    expect(first.title).toContain("Zqsearch Supply");
    expect(ids(res.body)).not.toContain(practice.poId);
  });

  it("the number is matched case-insensitively", async () => {
    const res = await search(PO_NUMBER.toLowerCase());
    expect(res.body.results[0]?.id).toBe(real.poId);
    expect(res.body.results[0]?.match).toBe("number");
  });

  it("an exact estimate number is the first result and opens the estimate drawer", async () => {
    const res = await search(real.estimateNumber);
    expect(res.status).toBe(200);
    const first = res.body.results[0];
    expect(first.kind).toBe("estimate");
    expect(first.id).toBe(real.estimateId);
    expect(first.match).toBe("number");
    expect(first.drawer).toEqual({ kind: "estimate", id: real.estimateId });
    expect(first.status).toBe("draft");
    expect(ids(res.body)).not.toContain(practice.estimateId);
  });

  it("a number PREFIX still outranks text matches", async () => {
    const res = await search("PO-2099-00");
    const first = res.body.results[0];
    expect(first.kind).toBe("po");
    expect(first.id).toBe(real.poId);
    expect(first.match).toBe("number_prefix");
    expect(ids(res.body)).not.toContain(practice.poId);
  });

  it("a number FRAGMENT is found, ranked as a fragment", async () => {
    const res = await search("0042");
    const po = res.body.results.find((r: SearchResult) => r.id === real.poId);
    expect(po).toBeDefined();
    expect(po.match).toBe("number_part");
  });
});

describe("GET /search — people and addresses", () => {
  it("a partial name finds the account first, then the lead, the job and the estimate — never the practice account", async () => {
    const res = await search("Zqsearch Godwin");
    expect(res.status).toBe(200);
    const kinds = res.body.results.map((r: SearchResult) => `${r.kind}:${r.id}`);
    expect(kinds[0]).toBe(`account:${real.customerId}`);
    expect(res.body.results[0].href).toBe(`/accounts/${real.customerId}`);
    expect(res.body.results[0].drawer).toBeNull();
    // Account, lead, job, estimate — that order, all on the real account.
    expect(kinds).toEqual([
      `account:${real.customerId}`,
      `lead:${real.leadId}`,
      `job:${real.visitId}`,
      `estimate:${real.estimateId}`,
    ]);
    for (const id of Object.values(practice)) expect(ids(res.body)).not.toContain(id);
  });

  it("a partial address finds the address (to its account), the job, the lead and the estimate", async () => {
    const res = await search("Zqcedar");
    const byKind = Object.fromEntries(res.body.results.map((r: SearchResult) => [r.kind, r]));
    expect(byKind.property.id).toBe(real.propertyId);
    expect(byKind.property.href).toBe(`/accounts/${real.customerId}`);
    expect(byKind.property.title).toContain("44 Zqcedar Ln");
    expect(byKind.job.id).toBe(real.visitId);
    expect(byKind.job.drawer).toEqual({ kind: "job", id: real.visitId });
    expect(byKind.job.status).toBe("scheduled");
    expect(byKind.lead.id).toBe(real.leadId);
    expect(byKind.lead.drawer).toEqual({ kind: "lead", id: real.leadId });
    expect(byKind.estimate.id).toBe(real.estimateId);
    for (const id of Object.values(practice)) expect(ids(res.body)).not.toContain(id);
    // Ranked: address before job before estimate (all text matches).
    const order = res.body.results.map((r: SearchResult) => r.kind);
    expect(order.indexOf("property")).toBeLessThan(order.indexOf("lead"));
    expect(order.indexOf("lead")).toBeLessThan(order.indexOf("job"));
    expect(order.indexOf("job")).toBeLessThan(order.indexOf("estimate"));
  });

  it("phone digits find the account and the lead in any stored format", async () => {
    const res = await search("555-0142");
    const byKind = Object.fromEntries(res.body.results.map((r: SearchResult) => [r.kind, r]));
    expect(byKind.account?.id).toBe(real.customerId);
    expect(byKind.lead?.id).toBe(real.leadId);
    expect(ids(res.body)).not.toContain(practice.customerId);
    expect(ids(res.body)).not.toContain(practice.leadId);
  });

  it("an address is not a phone number", () => {
    expect(phoneNeedle("108 Maple")).toBeNull();
    expect(phoneNeedle("(615) 555-0142")).toBe("6155550142");
    expect(phoneNeedle("615")).toBeNull();
  });

  it("a term that matches nothing returns an empty list, not an error", async () => {
    const res = await search("zzqqxx-nothing-here");
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([]);
    expect(res.body.more).toEqual({});
  });
});

describe("GET /search — caps, payload, auth", () => {
  it("caps each kind at `per` (default 5) and says when there is more", async () => {
    const capped = await search("Zqsearchmany");
    expect(capped.body.per).toBe(5);
    expect(capped.body.results.filter((r: SearchResult) => r.kind === "lead")).toHaveLength(5);
    expect(capped.body.more).toEqual({ lead: true });

    const widened = await search("Zqsearchmany", 10);
    expect(widened.body.per).toBe(10);
    expect(widened.body.results.filter((r: SearchResult) => r.kind === "lead")).toHaveLength(7);
    expect(widened.body.more).toEqual({});
  });

  it("refuses a term under two characters, over eighty, and a bad `per`", async () => {
    expect((await search("a")).status).toBe(400);
    expect((await search("x".repeat(81))).status).toBe(400);
    expect((await search("Zqsearch", 11)).status).toBe(400);
    expect((await request(app).get("/search")).status).toBe(400);
  });

  it("no capability token is anywhere in any payload (PUNCHLIST B4)", async () => {
    for (const q of [PO_NUMBER, real.estimateNumber, "Zqsearch Godwin", "Zqcedar", "555-0142"]) {
      const res = await search(q);
      expect(res.status).toBe(200);
      const text = JSON.stringify(res.body);
      expect(text).not.toMatch(/"token"/);
      expect(text).not.toMatch(/confirmationToken/);
      expect(text).not.toMatch(/imageData/);
      for (const r of res.body.results as SearchResult[]) {
        expect(Object.keys(r).sort()).toEqual(["at", "drawer", "href", "id", "kind", "match", "status", "subtitle", "title"]);
        if (r.drawer) expect(["po", "job", "estimate", "lead"]).toContain(r.drawer.kind);
        else expect(r.href).toMatch(/^\/accounts\//);
      }
    }
  });

  it("is searching with its trigram indexes in place", async () => {
    // globalSetup installs pg_trgm before `db push` builds the GIN indexes; a false here means
    // the test database no longer matches what the migration gives production.
    const res = await search("Zqsearch");
    expect(res.body.indexed).toBe(true);
    const idx = await prisma.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM pg_indexes WHERE indexname LIKE '%\\_trgm\\_idx'`;
    expect(idx[0].n).toBe(18);
  });

  it("is not a public route", () => {
    expect(isPublicRoute("GET", "/search")).toBe(false);
    expect(isPublicRoute("GET", "/api/search".replace(/^\/api/, ""))).toBe(false);
  });
});

describe("rankResults", () => {
  const row = (kind: SearchResult["kind"], match: SearchResult["match"], at: string, id = `${kind}-${match}-${at}`): SearchResult =>
    ({ kind, id, title: id, subtitle: null, status: null, match, drawer: null, href: null, at });

  it("orders by match, then kind, then recency", () => {
    const out = rankResults([
      row("po", "number_part", "2026-09-01T00:00:00.000Z"),
      row("estimate", "text", "2026-09-01T00:00:00.000Z"),
      row("account", "text", "2026-09-01T00:00:00.000Z"),
      row("account", "text", "2026-09-05T00:00:00.000Z", "newer-account"),
      row("estimate", "number_prefix", "2026-09-01T00:00:00.000Z"),
      row("po", "number", "2026-09-01T00:00:00.000Z"),
    ]).map((r) => r.id);
    expect(out).toEqual([
      "po-number-2026-09-01T00:00:00.000Z",
      "estimate-number_prefix-2026-09-01T00:00:00.000Z",
      "newer-account",
      "account-text-2026-09-01T00:00:00.000Z",
      "estimate-text-2026-09-01T00:00:00.000Z",
      "po-number_part-2026-09-01T00:00:00.000Z",
    ]);
  });
});
