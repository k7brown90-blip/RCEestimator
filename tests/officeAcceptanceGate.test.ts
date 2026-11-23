/**
 * ONE gate for "Customer accepted" (work order agent-team, TM0): shared/officeAcceptanceGate.ts. The CRM's
 * Estimate drawer prints its reason and acceptEstimateFromOffice refuses with it, so for EVERY estimate state
 * the sentence on the screen equals the server's refusal. The server is driven with a stand-in prisma whose
 * one lookup answers the state under test (every refusal is decided before any other read or write).
 */
import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { acceptEstimateFromOffice } from "../src/services/officeAcceptance";
import { officeAcceptanceBlock, expiredRefusal, type OfficeAcceptanceSubject } from "../shared/officeAcceptanceGate";

const DAY = 86_400_000;
const fresh = { createdAt: new Date(Date.now() - 2 * DAY), validDays: 30 };
const lapsed = { createdAt: new Date(Date.now() - 40 * DAY), validDays: 30 };

const STATES: Array<{ name: string; est: OfficeAcceptanceSubject & { voidedAt?: Date | null }; code: string | null }> = [
  { name: "sent", est: { status: "sent", signedAt: null, ...fresh }, code: null },
  { name: "viewed", est: { status: "viewed", signedAt: null, ...fresh }, code: null },
  { name: "already signed (signedAt)", est: { status: "sent", signedAt: new Date(), ...fresh }, code: "already_accepted" },
  { name: "already signed (status)", est: { status: "signed", signedAt: null, ...fresh }, code: "already_accepted" },
  { name: "void", est: { status: "void", signedAt: null, ...fresh }, code: "void" },
  { name: "voided (voidedAt)", est: { status: "sent", signedAt: null, voidedAt: new Date(), ...fresh }, code: "void" },
  { name: "lost", est: { status: "lost", signedAt: null, ...fresh }, code: "lost" },
  { name: "replaced by a newer revision", est: { status: "sent", signedAt: null, supersededBy: { revision: 3 }, ...fresh }, code: "superseded" },
  { name: "labelled expired", est: { status: "expired", signedAt: null, ...fresh }, code: "expired" },
  { name: "past validity but still labelled sent (the sweep has not run)", est: { status: "sent", signedAt: null, ...lapsed }, code: "expired" },
  { name: "draft (never sent)", est: { status: "draft", signedAt: null, ...fresh }, code: "not_sent" },
];

function fakePrisma(est: Record<string, unknown>): PrismaClient {
  return {
    issuedEstimate: {
      findUnique: async () => ({
        id: "est-1", number: "0000-1", revision: 1, voidedAt: null, lostAt: null, sentAt: null, exclusiveOptions: false,
        jobBandsJson: null, discountType: null, discountPercent: null, tripCharge: 0, supersededBy: null, options: [], ...est,
      }),
    },
  } as unknown as PrismaClient;
}

describe("officeAcceptanceBlock: the screen's sentence is the server's refusal, for every estimate state", () => {
  for (const state of STATES) {
    it(state.name, async () => {
      const block = officeAcceptanceBlock(state.est);
      expect(block?.code ?? null).toBe(state.code);
      if (!block) return;
      const server = await acceptEstimateFromOffice(fakePrisma(state.est), "est-1", { acceptedVia: "phone", acceptedBy: "Jane Homeowner" });
      expect(server.ok).toBe(false);
      if (!server.ok) {
        expect(server.status).toBe(409);
        expect(server.reason).toBe(block.reason);
      }
    });
  }

  it("keeps the wording the route test pins: a draft starts 'Never sent to the customer.' and an expired quote names Copy to new", () => {
    expect(officeAcceptanceBlock({ status: "draft", createdAt: fresh.createdAt, validDays: 30 })?.reason).toMatch(/^Never sent to the customer\./);
    expect(expiredRefusal(lapsed)).toMatch(/Use Copy to new to reissue at today's pricing\.$/);
  });

  it("an older client payload with no validDays is judged by its status label alone", () => {
    expect(officeAcceptanceBlock({ status: "sent", createdAt: lapsed.createdAt })).toBeNull();
    expect(officeAcceptanceBlock({ status: "expired", createdAt: lapsed.createdAt })?.code).toBe("expired");
  });
});
