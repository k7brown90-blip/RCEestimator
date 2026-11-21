/**
 * A lead carries TWO columns that both used to be able to say "lost": `status`
 * (new / contacted / converted / lost — Open vs Lost vs converted) and `leadStatus`, the "call
 * outcome" (new / booked / unresolved / planning / no_answer, plus lost / won written by the
 * buttons). Every one-click button wrote the pair together; the lead form wrote
 * them as two unlinked dropdowns, so a lead saved Status = lost kept a call outcome of "new" and a
 * lead reopened to Contacted stayed on the Closed tab (plan lead-intake-fixes, B4; Kyle,
 * 2026-11-15: "Rename to Call outcome").
 *
 * ONE rule, called by the CRM write doors (POST /crm/leads, PATCH /leads/:leadId):
 *
 *  - Status decides Open vs Lost. Status moved to lost            -> call outcome becomes lost.
 *  - Status moved to new/contacted while outcome = lost            -> outcome goes back to new.
 *  - Outcome moved to lost (Status not lost or converted)          -> Status becomes lost.
 *  - Outcome moved from lost to an open value while Status = lost  -> Status becomes contacted
 *    (as the booking flow writes alongside "booked").
 *  - When a save touches either column but neither MOVED (the form always sends both), a pair that
 *    disagrees on lost is healed the way the Closed tab already reads it: Status lost wins; an
 *    outcome of lost with Status new/contacted makes Status lost.
 *
 * Two things are never touched:
 *  - A CONVERTED lead (Status "converted") is an opportunity with an account and a job behind it.
 *    Marking its outcome lost must not demote it to lost — that would make it deletable and
 *    orphan the account (a converted lead can never be deleted, 2026-09-20 drawers plan).
 *  - The outcome "won". Convert writes it (older Savannah-era rows hold it too), and a customer delete resets a
 *    converted lead to Status new with outcome still "won". Rows holding it are left as they are
 *    and an edit of any other field never fails because of it.
 */

export interface LeadStatePair {
  status: string;
  leadStatus: string;
}

/** What a write is trying to set. `undefined` = not part of this write. */
export interface LeadStatePatch {
  status?: string | null;
  leadStatus?: string | null;
}

/** A brand-new lead starts here, which is also what the columns default to. */
const NEW_LEAD: LeadStatePair = { status: "new", leadStatus: "new" };

/** The pair a write should leave the row in. Pure — the caller decides which fields to store. */
export function reconcileLeadState(
  existing: LeadStatePair | null,
  patch: LeadStatePatch,
): LeadStatePair {
  const cur = existing ?? NEW_LEAD;
  let status = patch.status ?? cur.status;
  let leadStatus = patch.leadStatus ?? cur.leadStatus;

  // A converted lead is left exactly as the write puts it.
  if (status === "converted") return { status, leadStatus };

  const touched = patch.status != null || patch.leadStatus != null;
  const statusMoved = patch.status != null && patch.status !== cur.status;
  const outcomeMoved = patch.leadStatus != null && patch.leadStatus !== cur.leadStatus;

  if (statusMoved) {
    if (status === "lost") leadStatus = "lost";
    else if (leadStatus === "lost") leadStatus = "new";
  } else if (outcomeMoved) {
    if (leadStatus === "lost") status = "lost";
    else if (cur.leadStatus === "lost" && status === "lost") status = "contacted";
  } else if (touched) {
    if (status === "lost") leadStatus = "lost";
    else if (leadStatus === "lost") status = "lost";
  }

  return { status, leadStatus };
}

/** Why a CRM door refuses to SET the outcome "won" — only Convert makes a lead an opportunity. */
export const WON_OUTCOME_ERROR =
  "A lead becomes an opportunity only through the Convert button, which creates the account, "
  + "address and job together. The call outcome cannot be set to won by hand.";
