/**
 * Review fix on the "no AI questions" build (Kyle, 2026-11-28).
 *
 * The AI path (model answered) must still send `questions: []` beside `notPlaced`, on BOTH doors
 * (CRM POST /price-book/drafts/:id/propose and field POST /health-record/quotes/:id/walkthrough/
 * propose), because a CRM tab or phone still running the pre-deploy bundle reads
 * `r.questions.length` in its success handler. Without the key that handler throws AFTER the lines
 * were written, so the field app falls into "Basic match" and offers the same scope a second time.
 *
 * The model is mocked (no network). The degraded ("basic") branch is covered in
 * fieldQuoteSuggestions.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";

const mocks = vi.hoisted(() => ({ openaiCreate: vi.fn() }));
vi.mock("openai", () => ({
  default: class {
    responses = { create: mocks.openaiCreate };
  },
}));

import { prisma } from "../src/lib/prisma";
import { app } from "../src/app";
import { createDraft } from "../src/services/atomicEstimateService";
import { proposeWalkthroughForDraft } from "../src/services/aiProposer";
import { deleteAtomics, ensurePriceBookGates, quotableAtomic, seedAtomics } from "./helpers/priceBookFixture";

const REAL_ITEM = "P023_R001";
let draftId: string;
const savedKey = process.env.OPENAI_API_KEY;

beforeAll(async () => {
  process.env.OPENAI_API_KEY = "test-key-not-real";
  await ensurePriceBookGates();
  await seedAtomics([quotableAtomic(REAL_ITEM, { description: "Duplex receptacle, 15A tamper-resistant" })]);
  draftId = (await createDraft(prisma, { title: "old-bundle keys fixture", supplierId: "HD" })).id;
});

afterAll(async () => {
  if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = savedKey;
  await prisma.priceBookDraftLine.deleteMany({ where: { draftId } });
  await prisma.priceBookDraftQuestion.deleteMany({ where: { draftId } });
  await prisma.priceBookDraftEstimate.deleteMany({ where: { id: draftId } });
  await deleteAtomics([REAL_ITEM]);
});

function modelSays(payload: unknown): void {
  mocks.openaiCreate.mockResolvedValueOnce({ output_text: JSON.stringify(payload), usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } });
}

describe("the AI path keeps `questions: []` for a pre-deploy bundle, and still writes no question row", () => {
  it("service result: a placed line, a not-placed note and an empty questions list", async () => {
    modelSays({
      lines: [{ itemId: REAL_ITEM, quantity: 2, quantitySource: "COUNT", difficulty: "NORMAL", location: null, reasoning: "two receptacles" }],
      notPlaced: [{ text: "that odd plug by the pool", reason: "nothing in the book fits" }],
    });
    const r = await proposeWalkthroughForDraft(prisma, draftId, "2 receptacles and that odd plug by the pool");
    expect(r.path).toBe("ai");
    expect(r.proposed).toHaveLength(1);
    expect(r.notPlaced).toEqual([{ text: "that odd plug by the pool", reason: "nothing in the book fits" }]);
    expect(r.questions).toEqual([]);
    expect(await prisma.priceBookDraftQuestion.count({ where: { draftId } })).toBe(0);
  });

  it("CRM door answers with questions: [] on the AI path", async () => {
    modelSays({ lines: [], notPlaced: [{ text: "unplaceable thing", reason: "not in the book" }] });
    const res = await request(app).post(`/price-book/drafts/${draftId}/propose`).send({ text: "unplaceable thing" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.path).toBe("ai");
    expect(res.body.questions).toEqual([]);
    expect(res.body.notPlaced).toEqual([{ text: "unplaceable thing", reason: "not in the book" }]);
  });
});
