/**
 * The words and limits of office-made group chats (work order agent-team, C7), ONE definition read by the server
 * (services/hubGroups.ts, services/hub.ts) and the CRM (the New group chat dialog and the group's Members panel), so a
 * sentence the screen greys a button with is the sentence the server refuses with.
 */

export const GROUP_NAME_MAX = 120;
/** The most members one group holds. */
export const GROUP_MEMBER_MAX = 100;

/** Only the office (Kyle's PIN session or a CRM login) makes or changes a group; the AI admin session does not. */
export const GROUP_OFFICE_ONLY = "Only an office sign-in can make or change a group chat.";

/** Why nobody may post in a closed group (the Messages list hides it; Reopen brings it back). */
export const GROUP_CLOSED_POST_REASON = "This group is closed. Reopen it to post.";

/** Why an AI agent cannot be put in a group, or is dead weight in one: its key could not see or post there. One rule (hubKindsFor). */
export const GROUP_AGENT_CANNOT_REASON =
  "This agent's key has no Team replies scope (team:reply), or its thread kinds leave out Group chats, so it could not see or post in a group. Change the key on Settings \u2192 Agent keys.";

/** Why an approval is greyed when its draft was left in a group that is closed. */
export const GROUP_DRAFT_CLOSED_REASON = "This draft is in a closed group. Reopen the group to approve it, or Reject it.";

/** Why an approval is greyed when the agent that drafted it is no longer in the group. */
export const GROUP_DRAFT_LEFT_REASON = "The agent that wrote this draft is no longer a member of the group, so it cannot be posted. Reject it.";

/** Why Delete group is greyed on a group that has been used: its history is kept, and Close is the exit. */
export const GROUP_HAS_HISTORY_REASON = "This group has messages, so its history is kept. Use Close to take it off the Messages list.";
