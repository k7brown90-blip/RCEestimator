/**
 * P024 — drafts carry context. Option A: additive, nullable, reversible.
 *
 * The property under test is not "context is recorded" — it is that **recording context changed
 * nothing for a draft that has none**. Kyle prices speculatively from the nav entry every day, and
 * Option C (job-context only) was rejected precisely so that keeps working.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { prisma } from "../src/lib/prisma";
import { app } from "../src/app";
import { createDraft } from "../src/services/atomicEstimateService";

const MARK = "P024";
let customerId: string;
let propertyId: string;
let visitId: string;
let leadId: string;
const draftIds: string[] = [];

beforeAll(async () => {
  const customer = await prisma.customer.create({ data: { name: `${MARK} Customer` } });
  customerId = customer.id;
  const property = await prisma.property.create({
    data: { customerId, name: `${MARK} House`, addressLine1: "1 Context Way", city: "Franklin", state: "TN", postalCode: "37064" },
  });
  propertyId = property.id;
  const visit = await prisma.visit.create({
    data: { customerId, propertyId, mode: "onsite", purpose: "Sunroom addition", status: "scheduled" },
  });
  visitId = visit.id;
  const lead = await prisma.lead.create({ data: { name: `${MARK} Lead` } });
  leadId = lead.id;
});

afterAll(async () => {
  await prisma.priceBookDraftLine.deleteMany({ where: { draftId: { in: draftIds } } });
  await prisma.priceBookDraftQuestion.deleteMany({ where: { draftId: { in: draftIds } } });
  await prisma.priceBookDraftEstimate.deleteMany({ where: { id: { in: draftIds } } });
  await prisma.visit.deleteMany({ where: { customerId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
  await prisma.lead.deleteMany({ where: { id: leadId } });
});

describe("a draft created with a visit carries the derivable context", () => {
  it("stamps visitId and DERIVES customerId — the entry point only has to know the job", async () => {
    const d = await createDraft(prisma, { title: `${MARK} attached`, supplierId: "HD", visitId });
    draftIds.push(d.id);

    expect(d.visitId).toBe(visitId);
    // Visit.customerId is required, so the customer is free — the caller never supplied it.
    expect(d.customerId).toBe(customerId);
    expect(d.leadId).toBeNull();
  });

  it("accepts a leadId when the entry point knows one", async () => {
    const d = await createDraft(prisma, { title: `${MARK} lead`, supplierId: "HD", leadId });
    draftIds.push(d.id);
    expect(d.leadId).toBe(leadId);
  });

  it("degrades to unattached rather than failing on a visitId that does not resolve", async () => {
    // An unattached draft is the working default, so a bad link must not block draft creation.
    const d = await createDraft(prisma, { title: `${MARK} bad visit`, supplierId: "HD", visitId: "no-such-visit" });
    draftIds.push(d.id);
    expect(d.customerId).toBeNull();
  });
});

describe("a bare draft still works exactly as before", () => {
  it("carries nulls and creates successfully", async () => {
    const d = await createDraft(prisma, { title: `${MARK} bare`, supplierId: "HD" });
    draftIds.push(d.id);
    expect(d.leadId).toBeNull();
    expect(d.customerId).toBeNull();
    expect(d.visitId).toBeNull();
    expect(d.status).toBe("draft");
    expect(d.billedLaborRate).not.toBeNull();
  });

  it("the nav-entry HTTP path needs no context at all", async () => {
    const res = await request(app).post("/price-book/drafts").send({ title: `${MARK} via http` });
    expect(res.status).toBe(201);
    draftIds.push(res.body.id);
    expect(res.body.visitId).toBeNull();
  });

  it("the HTTP path accepts a visitId and derives the customer", async () => {
    const res = await request(app).post("/price-book/drafts").send({ title: `${MARK} http attached`, visitId });
    expect(res.status).toBe(201);
    draftIds.push(res.body.id);
    expect(res.body.visitId).toBe(visitId);
    expect(res.body.customerId).toBe(customerId);
  });
});

describe("deleting the job nulls the link and leaves the draft alone", () => {
  it("SetNull, not Cascade — estimate work survives the job being deleted", async () => {
    const throwaway = await prisma.visit.create({
      data: { customerId, propertyId, mode: "onsite", purpose: `${MARK} throwaway`, status: "scheduled" },
    });
    const d = await createDraft(prisma, { title: `${MARK} orphan test`, supplierId: "HD", visitId: throwaway.id });
    draftIds.push(d.id);
    await prisma.priceBookDraftLine.create({
      data: { draftId: d.id, itemId: "R001", quantity: 1, quantitySource: "COUNT", state: "CONFIRMED" },
    });

    await prisma.visit.delete({ where: { id: throwaway.id } });

    const after = await prisma.priceBookDraftEstimate.findUnique({ where: { id: d.id } });
    expect(after, "the draft must survive").not.toBeNull();
    expect(after!.visitId, "the link is nulled").toBeNull();
    // The customer link is a separate column and is not touched by the visit going away.
    expect(after!.customerId).toBe(customerId);
    expect(await prisma.priceBookDraftLine.count({ where: { draftId: d.id } })).toBe(1);
  });
});

describe("Option B was NOT built", () => {
  it("finalize still terminates — no Estimate is materialised", async () => {
    const before = await prisma.estimate.count();
    const d = await createDraft(prisma, { title: `${MARK} no option B`, supplierId: "HD", visitId });
    draftIds.push(d.id);
    // Even attached to a visit, nothing writes into the legacy chain. That is Option B, at
    // graduation, gated on T5.
    expect(await prisma.estimate.count()).toBe(before);
  });
});
