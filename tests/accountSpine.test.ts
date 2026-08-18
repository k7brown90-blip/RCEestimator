/**
 * P029 — the account spine.
 *
 * Kyle, 2026-08-18: *"All of it links to their account. Note: if they have multiple addresses on
 * file it needs to link to the address that we are working at."*
 *
 * The property these earn is that **the second sentence is enforced, not just the first.** An
 * account-level link is easy and would pass a careless test; what matters is that an account with
 * three properties produces an estimate naming the right one, and that nothing anywhere quietly
 * picks an address on the operator's behalf.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { prisma } from "../src/lib/prisma";
import { app } from "../src/app";
import { addLine, createDraft } from "../src/services/atomicEstimateService";
import { graduateDraft, signEstimateInPerson } from "../src/services/issuedEstimateService";
import {
  createJobFromSignedEstimate,
  deleteTestAccount,
  ensureTestAccount,
} from "../src/services/accountSpine";

const MARK = "P029";
const GOOD_A = "BF001";
const GOOD_B = "A008";

let accountId: string;
let addressA: string;
let addressB: string;
let otherAccountId: string;
let otherAddressId: string;
const draftIds: string[] = [];
const visitIds: string[] = [];

async function cleanup() {
  const ests = await prisma.issuedEstimate.findMany({
    where: { customerId: { in: [accountId, otherAccountId] } },
    select: { id: true },
  });
  const ids = ests.map((e) => e.id);
  await prisma.issuedEstimateEvent.deleteMany({ where: { estimateId: { in: ids } } });
  await prisma.issuedEstimateLine.deleteMany({ where: { estimateId: { in: ids } } });
  await prisma.issuedEstimate.updateMany({ where: { id: { in: ids } }, data: { supersedesId: null } });
  await prisma.issuedEstimate.deleteMany({ where: { id: { in: ids } } });
  await prisma.priceBookDraftLine.deleteMany({ where: { draftId: { in: draftIds } } });
  await prisma.priceBookDraftQuestion.deleteMany({ where: { draftId: { in: draftIds } } });
  await prisma.priceBookDraftEstimate.deleteMany({ where: { id: { in: draftIds } } });
  await prisma.visit.deleteMany({ where: { customerId: { in: [accountId, otherAccountId] } } });
  await prisma.property.deleteMany({ where: { customerId: { in: [accountId, otherAccountId] } } });
  await prisma.customer.deleteMany({ where: { id: { in: [accountId, otherAccountId] } } });
}

beforeAll(async () => {
  const account = await prisma.customer.create({
    data: { name: `${MARK} Two-Address Account`, email: "p029@example.com" },
  });
  accountId = account.id;

  // TWO addresses on file — the case Kyle called out by name.
  const a = await prisma.property.create({
    data: { customerId: accountId, name: "House", addressLine1: "1 First St", city: "La Vergne", state: "TN", postalCode: "37086" },
  });
  const b = await prisma.property.create({
    data: { customerId: accountId, name: "Rental", addressLine1: "2 Second Ave", city: "Smyrna", state: "TN", postalCode: "37167" },
  });
  addressA = a.id;
  addressB = b.id;

  const other = await prisma.customer.create({ data: { name: `${MARK} Someone Else` } });
  otherAccountId = other.id;
  const op = await prisma.property.create({
    data: { customerId: otherAccountId, name: "Theirs", addressLine1: "9 Other Rd", city: "Nashville", state: "TN", postalCode: "37201" },
  });
  otherAddressId = op.id;
});

afterAll(async () => {
  await cleanup();
  await deleteTestAccount(prisma).catch(() => undefined);
});

async function quotableDraft(title: string) {
  const d = await createDraft(prisma, { title: `${MARK} ${title}`, supplierId: "HD" });
  draftIds.push(d.id);
  await addLine(prisma, d.id, { itemId: GOOD_A, quantity: 1, quantitySource: "COUNT" });
  await addLine(prisma, d.id, { itemId: GOOD_B, quantity: 1, quantitySource: "COUNT" });
  return d;
}

// ─── Cannot issue unattached ────────────────────────────────────────────────────

describe("an estimate cannot exist without an account and an address", () => {
  it("the HTTP route refuses without either id — by request, not by a hidden field", async () => {
    const d = await quotableDraft("no-spine");

    const none = await request(app).post(`/price-book/drafts/${d.id}/issue`).send({});
    expect(none.status).toBe(400);

    const accountOnly = await request(app)
      .post(`/price-book/drafts/${d.id}/issue`)
      .send({ accountId });
    expect(accountOnly.status, "account without an address must not be enough").toBe(400);

    const addressOnly = await request(app)
      .post(`/price-book/drafts/${d.id}/issue`)
      .send({ serviceAddressId: addressA });
    expect(addressOnly.status).toBe(400);

    expect(await prisma.issuedEstimate.count({ where: { draftId: d.id } })).toBe(0);
  });

  it("refuses an address that belongs to a DIFFERENT account", async () => {
    const d = await quotableDraft("cross-account");
    const result = await graduateDraft(prisma, {
      draftId: d.id,
      accountId,
      serviceAddressId: otherAddressId,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasons.join(" ")).toMatch(/different account/i);
    expect(await prisma.issuedEstimate.count({ where: { draftId: d.id } })).toBe(0);
  });

  it("refuses an account or address that does not exist", async () => {
    const d = await quotableDraft("ghosts");
    const noAccount = await graduateDraft(prisma, {
      draftId: d.id,
      accountId: "no-such-account",
      serviceAddressId: addressA,
    });
    expect(noAccount.ok).toBe(false);

    const noAddress = await graduateDraft(prisma, {
      draftId: d.id,
      accountId,
      serviceAddressId: "no-such-address",
    });
    expect(noAddress.ok).toBe(false);
  });
});

// ─── The multi-address case, which is the whole point ───────────────────────────

describe("a multi-address account issues against the address that was chosen", () => {
  it("records address B when B was picked — and the record proves it", async () => {
    const d = await quotableDraft("address-b");
    const g = await graduateDraft(prisma, { draftId: d.id, accountId, serviceAddressId: addressB });
    expect(g.ok).toBe(true);
    if (!g.ok) return;

    const est = await prisma.issuedEstimate.findUnique({
      where: { id: g.estimateId },
      include: { serviceProperty: true, account: true },
    });

    expect(est!.customerId).toBe(accountId);
    expect(est!.serviceAddressId).toBe(addressB);
    expect(est!.serviceProperty.addressLine1).toBe("2 Second Ave");
    // The frozen TEXT agrees with the link — the document says the same street the id points at.
    expect(est!.serviceAddress).toContain("2 Second Ave");
    expect(est!.serviceAddress).not.toContain("1 First St");
    expect(est!.customerName).toBe(`${MARK} Two-Address Account`);
  });

  it("the account's estimate list filters per address", async () => {
    const dA = await quotableDraft("filter-a");
    const gA = await graduateDraft(prisma, { draftId: dA.id, accountId, serviceAddressId: addressA });
    const dB = await quotableDraft("filter-b");
    const gB = await graduateDraft(prisma, { draftId: dB.id, accountId, serviceAddressId: addressB });
    expect(gA.ok && gB.ok).toBe(true);

    const all = await request(app).get(`/accounts/${accountId}/estimates`);
    expect(all.status).toBe(200);
    expect(all.body.estimates.length).toBeGreaterThanOrEqual(2);

    const onlyB = await request(app).get(`/accounts/${accountId}/estimates?serviceAddressId=${addressB}`);
    expect(onlyB.status).toBe(200);
    for (const row of onlyB.body.estimates) {
      expect(row.serviceAddressId).toBe(addressB);
    }
  });
});

// ─── Signed → job, inheriting both ──────────────────────────────────────────────

describe("a signed quote becomes a job on the same account and address", () => {
  it("inherits both ids from the signed revision", async () => {
    const d = await quotableDraft("to-job");
    const g = await graduateDraft(prisma, { draftId: d.id, accountId, serviceAddressId: addressB });
    expect(g.ok).toBe(true);
    if (!g.ok) return;

    await signEstimateInPerson(prisma, g.estimateId, { signerName: "Test Signature" });
    const job = await createJobFromSignedEstimate(prisma, g.estimateId);
    expect(job.ok).toBe(true);
    if (!job.ok) return;
    visitIds.push(job.visitId);

    const visit = await prisma.visit.findUnique({ where: { id: job.visitId } });
    expect(visit!.customerId).toBe(accountId);
    expect(visit!.propertyId).toBe(addressB);
    expect(visit!.status).toBe("contracted");

    const est = await prisma.issuedEstimate.findUnique({
      where: { id: g.estimateId },
      include: { events: true },
    });
    expect(est!.jobVisitId).toBe(job.visitId);
    expect(est!.events.map((e) => e.type)).toContain("job_created");
  });

  it("refuses to make a job from an UNSIGNED estimate", async () => {
    const d = await quotableDraft("unsigned");
    const g = await graduateDraft(prisma, { draftId: d.id, accountId, serviceAddressId: addressA });
    expect(g.ok).toBe(true);
    if (!g.ok) return;

    const job = await createJobFromSignedEstimate(prisma, g.estimateId);
    expect(job.ok).toBe(false);
    if (!job.ok) expect(job.reason).toMatch(/not been signed/i);
  });

  it("is idempotent — a second tap returns the same job rather than a duplicate", async () => {
    const d = await quotableDraft("idempotent");
    const g = await graduateDraft(prisma, { draftId: d.id, accountId, serviceAddressId: addressA });
    expect(g.ok).toBe(true);
    if (!g.ok) return;
    await signEstimateInPerson(prisma, g.estimateId, { signerName: "Test Signature" });

    const first = await createJobFromSignedEstimate(prisma, g.estimateId);
    const second = await createJobFromSignedEstimate(prisma, g.estimateId);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    visitIds.push(first.visitId);

    expect(second.visitId).toBe(first.visitId);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
  });
});

// ─── The signed artifact stays immutable ────────────────────────────────────────

describe("context is fixed at issuance", () => {
  it("a revision stays on the same account and address, and the signed row does not move", async () => {
    const d = await quotableDraft("revise-spine");
    const g = await graduateDraft(prisma, { draftId: d.id, accountId, serviceAddressId: addressB });
    expect(g.ok).toBe(true);
    if (!g.ok) return;
    await signEstimateInPerson(prisma, g.estimateId, { signerName: "Original" });

    const before = await prisma.issuedEstimate.findUnique({ where: { id: g.estimateId } });

    const { reviseEstimate } = await import("../src/services/issuedEstimateService");
    const rev = await reviseEstimate(prisma, g.estimateId);
    expect(rev.ok).toBe(true);
    if (!rev.ok) return;

    const next = await prisma.issuedEstimate.findUnique({ where: { id: rev.estimateId } });
    expect(next!.customerId).toBe(accountId);
    expect(next!.serviceAddressId).toBe(addressB);

    // The original is untouched: same address, same signature.
    const after = await prisma.issuedEstimate.findUnique({ where: { id: g.estimateId } });
    expect(after!.serviceAddressId).toBe(before!.serviceAddressId);
    expect(after!.serviceAddress).toBe(before!.serviceAddress);
    expect(after!.signerName).toBe("Original");
  });

  it("an account with an issued estimate cannot be deleted out from under it", async () => {
    const d = await quotableDraft("fk-guard");
    const g = await graduateDraft(prisma, { draftId: d.id, accountId, serviceAddressId: addressA });
    expect(g.ok).toBe(true);
    // Restrict, not Cascade — the estimate is the record of what was quoted.
    await expect(prisma.customer.delete({ where: { id: accountId } })).rejects.toThrow();
    await expect(prisma.property.delete({ where: { id: addressA } })).rejects.toThrow();
  });
});

// ─── The test account: marked, excluded, deletable ──────────────────────────────

describe("the test account is an instrument with a delete button", () => {
  it("is marked, and its rows stay out of the Estimates chain view", async () => {
    const { account, property } = await ensureTestAccount(prisma);
    expect(account.isTestAccount).toBe(true);

    const d = await createDraft(prisma, { title: `${MARK} test-acct`, supplierId: "HD" });
    await addLine(prisma, d.id, { itemId: GOOD_A, quantity: 1, quantitySource: "COUNT" });
    const g = await graduateDraft(prisma, {
      draftId: d.id,
      accountId: account.id,
      serviceAddressId: property.id,
    });
    expect(g.ok).toBe(true);
    if (!g.ok) return;

    const chain = await request(app).get("/issued-estimates/chain");
    expect(chain.status).toBe(200);
    const ids = chain.body.estimates.map((e: { id: string }) => e.id);
    expect(ids, "test rows must not mix into the real numbers").not.toContain(g.estimateId);

    // ...but they are reachable when explicitly asked for.
    const withTest = await request(app).get("/issued-estimates/chain?includeTest=true");
    expect(withTest.body.estimates.map((e: { id: string }) => e.id)).toContain(g.estimateId);
  });

  it("deletes the whole account in one action, and only a marked one", async () => {
    await ensureTestAccount(prisma);
    const result = await deleteTestAccount(prisma);
    expect(result.deleted).toBe(true);
    expect(await prisma.customer.count({ where: { isTestAccount: true } })).toBe(0);

    // Nothing left behind, and the real account is untouched.
    expect(await prisma.customer.findUnique({ where: { id: accountId } })).not.toBeNull();

    // A second call is a no-op rather than an error.
    const again = await deleteTestAccount(prisma);
    expect(again.deleted).toBe(false);
  });
});
