/**
 * Editing and removing a line the tech already committed.
 *
 * Kyle, 2026-08-17, from the estimator: **"I also have no way to edit or delete an entry already
 * submitted."** He was right twice over — `editLine` existed in the service layer with no HTTP
 * surface, and `DELETE /price-book/lines/:lineId` had an HTTP surface with no caller in the UI.
 *
 * What these pin is not "the buttons work". It is the guard that only started mattering once the
 * buttons existed: **a finalized estimate is a record, not a working document.** Until this task
 * nothing reached `removeLine`, so its missing status check cost nothing. Wire a button to it and
 * the same function will happily delete a line out of a quote already sitting in a customer's
 * inbox, changing the price under it with no trace.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { prisma } from "../src/lib/prisma";
import { app } from "../src/app";
import { addLine, createDraft } from "../src/services/atomicEstimateService";

const MARK = "P026-lines";
const draftIds: string[] = [];

async function newDraft(title: string) {
  const d = await createDraft(prisma, { title: `${MARK} ${title}`, supplierId: "HD" });
  draftIds.push(d.id);
  return d;
}

beforeAll(async () => {
  // Nothing to stand up — drafts are created per test so one test's edits cannot move another's.
});

afterAll(async () => {
  await prisma.priceBookDraftLine.deleteMany({ where: { draftId: { in: draftIds } } });
  await prisma.priceBookDraftQuestion.deleteMany({ where: { draftId: { in: draftIds } } });
  await prisma.priceBookDraftEstimate.deleteMany({ where: { id: { in: draftIds } } });
});

describe("PATCH /price-book/lines/:lineId", () => {
  it("edits quantity, difficulty, location and note on a confirmed line", async () => {
    const d = await newDraft("patch");
    const line = await addLine(prisma, d.id, {
      itemId: "R001",
      quantity: 2,
      quantitySource: "COUNT",
      location: "kitchen",
    });

    const res = await request(app)
      .patch(`/price-book/lines/${line.id}`)
      .send({ quantity: 5, difficulty: "DIFFICULT", location: "garage", note: "recount after walkthrough" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const after = await prisma.priceBookDraftLine.findUnique({ where: { id: line.id } });
    expect(after!.quantity).toBe(5);
    expect(after!.difficulty).toBe("DIFFICULT");
    expect(after!.location).toBe("garage");
    expect(after!.note).toBe("recount after walkthrough");
    // The line stays CONFIRMED — an edit is not a re-proposal.
    expect(after!.state).toBe("CONFIRMED");
  });

  it("refuses a zero or negative quantity — that is not a priced line", async () => {
    const d = await newDraft("patch-zero");
    const line = await addLine(prisma, d.id, { itemId: "R001", quantity: 1, quantitySource: "COUNT" });

    const res = await request(app).patch(`/price-book/lines/${line.id}`).send({ quantity: 0 });

    // Zod rejects it before the service does; either way the line must not move.
    expect(res.status).toBe(400);
    const after = await prisma.priceBookDraftLine.findUnique({ where: { id: line.id } });
    expect(after!.quantity).toBe(1);
  });

  it("REOPENS a finalized draft on edit when nothing from it is signed", async () => {
    /*
      This test used to assert the refusal — until Kyle hit it from the Edit button on
      2026-08-22: "I still cannot edit this draft." The rule moved: the frozen record is the
      ISSUED estimate now, not the draft, so an unsigned draft reopens and re-issuing supersedes.
      The refusal lives at the signature; see "stays shut once a signature exists" in
      issuedEstimate.test.ts.
    */
    const d = await newDraft("patch-finalized");
    const line = await addLine(prisma, d.id, { itemId: "R001", quantity: 3, quantitySource: "COUNT" });
    await prisma.priceBookDraftEstimate.update({
      where: { id: d.id },
      data: { status: "finalized", finalizedAt: new Date() },
    });

    const res = await request(app).patch(`/price-book/lines/${line.id}`).send({ quantity: 99 });

    expect(res.status).toBe(200);
    const after = await prisma.priceBookDraftLine.findUnique({ where: { id: line.id } });
    expect(after!.quantity).toBe(99);
    const draft = await prisma.priceBookDraftEstimate.findUnique({ where: { id: d.id } });
    expect(draft!.status).toBe("draft"); // reopened, honestly — re-issue will re-finalize
  });
});

describe("DELETE /price-book/lines/:lineId", () => {
  it("removes a confirmed line from a draft", async () => {
    const d = await newDraft("delete");
    const line = await addLine(prisma, d.id, { itemId: "R001", quantity: 1, quantitySource: "COUNT" });

    const res = await request(app).delete(`/price-book/lines/${line.id}`);

    expect(res.status).toBe(204);
    expect(await prisma.priceBookDraftLine.findUnique({ where: { id: line.id } })).toBeNull();
  });

  it("reopens on remove too — same rule, same wall at the signature", async () => {
    const d = await newDraft("delete-finalized");
    const line = await addLine(prisma, d.id, { itemId: "R001", quantity: 4, quantitySource: "COUNT" });
    await prisma.priceBookDraftEstimate.update({
      where: { id: d.id },
      data: { status: "finalized", finalizedAt: new Date() },
    });

    const res = await request(app).delete(`/price-book/lines/${line.id}`);

    expect(res.status).toBe(204);
    expect(await prisma.priceBookDraftLine.findUnique({ where: { id: line.id } })).toBeNull();
    const draft = await prisma.priceBookDraftEstimate.findUnique({ where: { id: d.id } });
    expect(draft!.status).toBe("draft");
  });

  it("reports a missing line rather than succeeding silently", async () => {
    const res = await request(app).delete("/price-book/lines/no-such-line-id");
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain("not found");
  });
});
