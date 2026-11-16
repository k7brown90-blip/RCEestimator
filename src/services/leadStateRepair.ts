/**
 * One-time repair of leads whose two columns disagree about LOST (plan lead-intake-fixes, B4).
 *
 * Before the lead form wrote the pair together, a lead entered with Status = lost kept a call
 * outcome (`leadStatus`) of "new", so the Open tab called it Closed while every other count called it
 * open. The rule that now keeps them in step is `reconcileLeadState`; this applies the SAME rule to
 * the rows already stored, so there is one definition of "in step", not two.
 *
 * - Status lost, outcome not lost         -> outcome becomes lost.
 * - Outcome lost, Status new or contacted -> Status becomes lost (what the Closed tab already shows).
 * - Converted leads are never touched (they have an account and a job behind them).
 * - Rows holding the outcome "won" with Status other than converted are only REPORTED. Two things
 *   make them: Savannah's call-disposition tool writes "won", and deleting an account resets its
 *   converted leads to Status new while leaving "won". Kyle decides what each one is.
 *
 * Dry by default; `apply: true` writes. It updates only the mismatched rows, by id.
 */

import { prisma } from "../lib/prisma";
import { reconcileLeadState } from "./leadState";

export interface LeadStateChange {
  id: string;
  name: string;
  from: { status: string; leadStatus: string };
  to: { status: string; leadStatus: string };
}

export interface WonWithoutConversion {
  id: string;
  name: string;
  status: string;
  leadStatus: string;
}

export interface LeadStateRepairReport {
  applied: boolean;
  scanned: number;
  changes: LeadStateChange[];
  wonWithoutConversion: WonWithoutConversion[];
}

export async function repairLeadLostState(opts: { apply: boolean }): Promise<LeadStateRepairReport> {
  const rows = await prisma.lead.findMany({
    select: { id: true, name: true, status: true, leadStatus: true },
    orderBy: { createdAt: "asc" },
  });

  const changes: LeadStateChange[] = [];
  const wonWithoutConversion: WonWithoutConversion[] = [];

  for (const row of rows) {
    if (row.status === "converted") continue;
    if (row.leadStatus === "won") {
      wonWithoutConversion.push(row);
      continue;
    }
    const to = reconcileLeadState(row, { status: row.status, leadStatus: row.leadStatus });
    if (to.status === row.status && to.leadStatus === row.leadStatus) continue;
    changes.push({
      id: row.id,
      name: row.name,
      from: { status: row.status, leadStatus: row.leadStatus },
      to,
    });
  }

  if (opts.apply) {
    for (const change of changes) {
      await prisma.lead.update({
        where: { id: change.id },
        data: { status: change.to.status, leadStatus: change.to.leadStatus },
      });
    }
  }

  return { applied: opts.apply, scanned: rows.length, changes, wonWithoutConversion };
}
