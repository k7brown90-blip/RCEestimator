/**
 * What a price-change card carries (services/priceBookProposals.ts): the pure part, with no database and no hub import, so the event
 * builder (services/hubEvents.ts) can read a card's proposal without importing the hub it is imported by.
 */
import { z } from "zod";
import type { AtomicPatch } from "./priceBookCatalog";

export const PRICE_CHANGE_KIND = "price_change";

/** The fields a proposal may touch: name, price (the cost, before tax) and the three hour tiers. Nothing else, ever. */
export const PROPOSABLE_FIELDS = ["description", "companyCost", "laborNormal", "laborDifficult", "laborVeryDifficult"] as const;
export type ProposableField = (typeof PROPOSABLE_FIELDS)[number];

const payloadSchema = z.object({
  v: z.literal(1),
  itemId: z.string().min(1).max(64),
  proposed: z.object({
    description: z.string().min(1).max(200).optional(),
    companyCost: z.number().nonnegative().optional(),
    laborNormal: z.number().nonnegative().optional(),
    laborDifficult: z.number().nonnegative().optional(),
    laborVeryDifficult: z.number().nonnegative().optional(),
  }).strict(),
  keyId: z.string().min(1).max(64),
  keyName: z.string().min(1).max(120),
});
export type PriceChangePayload = z.infer<typeof payloadSchema>;

export function parsePriceChangePayload(json: string | null | undefined): PriceChangePayload | null {
  if (!json) return null;
  try {
    const parsed = payloadSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export const serializePriceChangePayload = (payload: PriceChangePayload): string => JSON.stringify(payload);

/** The proposal as the book's own patch (the field names updateAtomic takes). */
export const patchOf = (payload: PriceChangePayload): AtomicPatch => ({ ...payload.proposed });

/** What PriceBookEdit.editedBy holds for an agent's write: the key's NAME, cleaned and bounded (a name is chosen by Kyle, never by the agent). */
export const agentEditorName = (keyName: string): string =>
  `agent:${keyName.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60)}`;
