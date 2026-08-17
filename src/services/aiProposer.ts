/**
 * The AI proposer for the intake walkthrough — F10, the wire P019 found missing.
 *
 * P019's headline: `propose_estimate_lines` existed, worked, and was reachable ONLY by a model
 * driving `/mcp`. The intake screen could not call it, so Kyle had never seen the intelligent
 * matcher — the token matcher was not its fallback, it was the only thing that screen had. This
 * module is the missing edge.
 *
 * ── WHY IT CALLS proposeLines() RATHER THAN DRIVING /mcp ─────────────────────────────────────
 *
 * The MCP surface exists so a model can act through tools. Here the server is the one initiating,
 * and routing our own request out through our own HTTP tool endpoint would add a transport, a
 * session handshake and a second auth path for no gain. Instead the model returns structured
 * proposals and this module hands them to `proposeLines()` — **the same function the MCP tool
 * calls**, so every P011 guarantee is enforced by the same code:
 *
 *   * lines land `PROPOSED` and price nothing until a human confirms;
 *   * an itemId that is not a live `PriceBookAtomic` becomes a QUESTION, never a nearest guess;
 *   * a line without reasoning is rejected;
 *   * the model cannot confirm, price, finalize, or set a difficulty multiplier — difficulty is
 *     an enum selecting a published NECA column, not a number.
 *
 * Those are not re-implemented here. If they ever change, they change in one place.
 *
 * ── WHY THE WHOLE CATALOG GOES IN THE PROMPT ─────────────────────────────────────────────────
 *
 * The obvious design is to retrieve candidates first and show the model a shortlist. That
 * reintroduces the exact failure P019 documented: retrieval by token match cannot find "wafer"
 * (the catalog says "Canless"), so a shortlist would omit the right answer before the model ever
 * sees it. At 323 rows the entire catalog is a few thousand tokens — cheaper than being wrong.
 * The cost is measured and reported rather than assumed.
 *
 * Revisit if the catalog grows an order of magnitude.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DO ───────────────────────────────────────────────────────
 *
 * No code-compliance flags. The model is not asked to cite NEC sections, because it cannot ground
 * them until the Phase 4 retrieval build exists, and an ungrounded citation is a fabrication with
 * a reference number attached. That role lands with NEC retrieval, not here.
 */

import type { PrismaClient } from "@prisma/client";
import { proposeLines, type ProposeResult } from "./atomicEstimateService";

/** Which brain produced a result. The UI shows this — a tech should never wonder. */
export type ProposalPath = "ai" | "basic";

export interface ProposerUsage {
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  elapsedMs: number;
}

export interface AiProposalOutcome {
  path: ProposalPath;
  result: ProposeResult;
  usage: ProposerUsage | null;
  /** Present when the AI path could not run. The UI shows it beside the "basic match" badge. */
  degradedReason?: string;
}

/** Raised when the AI path cannot run. The caller falls back to the token matcher. */
export class ProposerUnavailable extends Error {}

const MODEL = process.env.AI_ESTIMATE_MODEL ?? "gpt-5.1";
const MODEL_ACTOR = `ai:${MODEL}`;

/**
 * The instruction block.
 *
 * Written against the three failure classes P019 §2 recorded, because those are what the token
 * matcher could not do and are the reason this path exists.
 */
const INSTRUCTIONS = `You compose electrical estimate line items from an electrician's walkthrough notes.

You are given the COMPLETE catalog. Every line you propose MUST use an itemId from it, copied
exactly. Never invent an itemId. Never adapt one. If nothing in the catalog fits, that scope
becomes a question instead of a line — an unmatched item is a question for the tech, not a
nearest-guess match.

QUANTITIES
- A count of devices is a quantity: "5 duplex receptacles" -> quantity 5.
- A measured run is a quantity in feet: "100 ft 14/2" -> quantity 100, quantitySource MEASURED_LENGTH.
- A ROOM DIMENSION IS NOT A QUANTITY. "12 ft x 12 ft" describes the room; it is context for how
  much cable or how many devices might be needed, never a line with quantity 12. If a dimension
  is all you have for an item, ask a question.
- Anything sold by the foot must use MEASURED_LENGTH. Counted things use COUNT.
- If the notes do not give a quantity, propose your best reading and say so in the reasoning —
  the tech corrects every quantity before it counts.

VOCABULARY
The catalog uses manufacturer wording; electricians use trade wording. Match on meaning, using the
description text to justify it. Examples of the gap: a "wafer light" or "canless downlight" is a
recessed LED downlight; "romex" is NM-B cable; a "sconce" is a wall luminaire. Plurals, hyphens and
abbreviations are never a reason to fail a match. If you match on trade wording, say which words in
the description justify it.

DIFFICULTY
NORMAL unless the notes describe conditions that justify more. It selects a published labour
column. You cannot supply a number.

WHAT YOU CANNOT DO
You cannot price, confirm, or finalize anything. Every line you propose waits for the tech, who has
final authority and will drop or add whatever they want. Do not cite NEC code sections — you cannot
verify them here, and an unverifiable citation is worse than none.

Return JSON only, matching the schema you are given.`;

/** The response contract. Enforced by the API, then re-checked by proposeLines(). */
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["lines", "questions"],
  properties: {
    // OpenAI's strict mode requires EVERY property to appear in `required`; optionality is
    // expressed by allowing null, not by omission. Getting this wrong is a 400, which the
    // degraded path turns into a silent fallback to the token matcher — so it is worth being
    // explicit about.
    lines: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["itemId", "quantity", "quantitySource", "difficulty", "location", "reasoning"],
        properties: {
          itemId: { type: "string" },
          quantity: { type: "number" },
          quantitySource: { type: "string", enum: ["COUNT", "MEASURED_LENGTH", "TERMINATION_COUNT", "MANUAL"] },
          difficulty: { type: ["string", "null"], enum: ["NORMAL", "DIFFICULT", "VERY_DIFFICULT", null] },
          location: { type: ["string", "null"] },
          reasoning: { type: "string" },
        },
      },
    },
    questions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["question", "rawText"],
        properties: {
          question: { type: "string" },
          rawText: { type: ["string", "null"] },
        },
      },
    },
  },
} as const;

interface ModelLine {
  itemId: string;
  quantity: number;
  quantitySource: "COUNT" | "MEASURED_LENGTH" | "TERMINATION_COUNT" | "MANUAL";
  difficulty?: "NORMAL" | "DIFFICULT" | "VERY_DIFFICULT";
  location?: string | null;
  reasoning: string;
}

/** The catalog as the model sees it: id, description, unit. Nothing priced — it cannot price. */
async function catalogForPrompt(prisma: PrismaClient): Promise<string> {
  const rows = await prisma.priceBookAtomic.findMany({
    where: { retiredAt: null },
    orderBy: { itemId: "asc" },
    select: { itemId: true, description: true, unit: true, category: true },
  });
  return rows
    .map((r) => `${r.itemId}\t${r.unit ?? "-"}\t${r.category ?? "-"}\t${r.description ?? ""}`)
    .join("\n");
}

/**
 * Run the walkthrough through the model and land the results as PROPOSED lines.
 * Throws `ProposerUnavailable` when the AI path cannot run — the caller degrades.
 */
export async function proposeFromWalkthrough(
  prisma: PrismaClient,
  draftId: string,
  walkthroughText: string,
): Promise<AiProposalOutcome> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new ProposerUnavailable("OPENAI_API_KEY is not set");
  if (!walkthroughText.trim()) throw new ProposerUnavailable("empty walkthrough");

  const catalog = await catalogForPrompt(prisma);
  if (!catalog) throw new ProposerUnavailable("the catalog is empty");

  const startedAt = Date.now();
  const { default: OpenAI } = await import("openai");
  const openai = new OpenAI({ apiKey });

  let response: unknown;
  try {
    response = await openai.responses.create({
      model: MODEL,
      instructions: INSTRUCTIONS,
      input: `CATALOG (itemId, unit, category, description — tab separated):\n${catalog}\n\nWALKTHROUGH NOTES:\n${walkthroughText}`,
      stream: false,
      max_output_tokens: 8000,
      text: { format: { type: "json_schema", name: "estimate_proposal", strict: true, schema: SCHEMA } },
    } as Parameters<typeof openai.responses.create>[0]);
  } catch (err) {
    throw new ProposerUnavailable(err instanceof Error ? err.message : String(err));
  }

  const resp = response as {
    output_text?: string;
    output?: Array<{ type: string; content?: Array<{ type: string; text?: string }> }>;
    usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
  };

  const raw =
    resp.output_text ??
    resp.output
      ?.filter((i) => i.type === "message")
      .flatMap((i) => i.content ?? [])
      .filter((c) => c.type === "output_text")
      .map((c) => c.text ?? "")
      .join("") ??
    "";

  let parsed: { lines?: ModelLine[]; questions?: Array<{ question: string; rawText?: string | null }> };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    // A model that returns unparseable output is unavailable, not authoritative. Degrade rather
    // than half-apply something we cannot read.
    throw new ProposerUnavailable("model returned output that was not valid JSON");
  }

  const usage: ProposerUsage = {
    model: MODEL,
    inputTokens: resp.usage?.input_tokens ?? null,
    outputTokens: resp.usage?.output_tokens ?? null,
    totalTokens: resp.usage?.total_tokens ?? null,
    elapsedMs: Date.now() - startedAt,
  };

  // proposeLines() is the gate. Anything the model got wrong — a hallucinated itemId, a
  // non-positive quantity, a missing reason — is refused there and becomes a question, using
  // exactly the same code path the MCP tool goes through.
  const result = await proposeLines(
    prisma,
    draftId,
    (parsed.lines ?? []).map((l) => ({
      itemId: l.itemId,
      quantity: l.quantity,
      quantitySource: l.quantitySource,
      difficulty: l.difficulty,
      location: l.location ?? null,
      reasoning: l.reasoning,
    })),
    (parsed.questions ?? []).map((q) => ({ question: q.question, rawText: q.rawText ?? null })),
    MODEL_ACTOR,
  );

  return { path: "ai", result, usage };
}
