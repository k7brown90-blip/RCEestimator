/**
 * The account's conversation notes (a phone call written down). The write lives here so the CRM's
 * "Add call note" and the agent tools make one kind of note by one code path (work order agent-team,
 * TM0). The route owns the request parsing and the status codes; this returns an outcome.
 *
 * EDITED SHOWS AS EDITED: create pins `createdAt` and `updatedAt` to the same instant, so
 * `updatedAt > createdAt` is true only after a real PATCH (tests/accountNotes.test.ts pins it).
 * Note bodies are customer-entered information about a person: never written to SystemEvent.
 *
 * `db` is the client OR a transaction client, so a caller that has just made the job inside its own
 * transaction (convertLeadToOpportunity's "From the lead:" note) files the note through this same
 * function and the same visit-belongs-to-this-account check, never a second writer.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import type { DoorActor } from "./doorActor";

/** The longest a call note's body may be: the cap on POST and PATCH /accounts/:id/notes, and the cut the lead's "From the lead:" note is held to so Edit can always save it. */
export const ACCOUNT_NOTE_BODY_MAX = 10_000;

export const CUSTOMER_NOTE_INCLUDE = {
  visit: {
    select: {
      id: true, jobType: true, purpose: true, visitDate: true,
      property: { select: { addressLine1: true } },
    },
  },
} as const;

export interface CreateAccountNoteInput {
  body: string;
  takenBy: string;
  visitId?: string | null;
}

export async function createAccountNote(
  db: PrismaClient | Prisma.TransactionClient,
  customerId: string,
  input: CreateAccountNoteInput,
  // The door's identity; the note itself records `takenBy`, so nothing here reads it yet.
  _actor: DoorActor,
) {
  const customer = await db.customer.findUnique({ where: { id: customerId }, select: { id: true } });
  if (!customer) return { ok: false as const, status: 404 as const, error: "Account not found" };

  // The tag must point at one of THIS account's jobs — a note can never be filed against one
  // customer while naming another customer's job.
  if (input.visitId) {
    const visit = await db.visit.findUnique({ where: { id: input.visitId }, select: { customerId: true } });
    if (!visit || visit.customerId !== customerId) {
      return { ok: false as const, status: 400 as const, error: "That job is not on this account." };
    }
  }

  const now = new Date();
  const note = await db.customerNote.create({
    data: {
      customerId,
      visitId: input.visitId ?? null,
      body: input.body,
      takenBy: input.takenBy,
      createdAt: now,
      updatedAt: now,
    },
    include: CUSTOMER_NOTE_INCLUDE,
  });
  return { ok: true as const, note };
}
