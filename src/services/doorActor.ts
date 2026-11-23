/**
 * Who is doing a thing, for the services that more than one door calls (work order agent-team, TM0).
 * A route (the CRM session) passes "human:crm-session"; an agent tool passes "agent:<key name>". The
 * services pass it on to whatever audit they already write; none of them decides anything from it
 * (the door has already authorised the call), so a person's and an agent's call run the same code.
 */
export type DoorActor = "human:crm-session" | `agent:${string}`;

export const HUMAN_CRM_SESSION: DoorActor = "human:crm-session";
