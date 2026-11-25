/**
 * Office-made group chats (work order agent-team, C7). Kyle, 2026-11-22: "I would rather beable to create a custom
 * chat that allows flexibility as the team grows. The office can create the chat groups and assign members to it
 * including specific AI bots".
 *
 * A group is an ordinary hub thread of kind `group` (services/hub.ts): its name is the thread's title, it is posted in
 * through postMessage (the ONE message writer), announced through fanOutMessage (the ONE fan-out), counted by
 * unreadCounts and seen through visibleThreadWhere. What is new, and all that lives here, is who is IN it and the
 * office's way to change that:
 *
 *   * members: HubThreadMember rows, a person (Technician.id) or an agent (AgentKey.id, active keys only). A customer is
 *     never a member - there is no way to name one;
 *   * who may make and change a group: any office sign-in (an owner or a CRM login: "the office"). The AI admin
 *     session may not, and a technician or an agent key never reaches these functions;
 *   * the exits, every one audited (HubAuditLog): rename (hub.ts renameThread), add and remove a member, close and
 *     reopen (hub.ts setThreadStatus), and Delete group - only while the group holds no message at all. A group
 *     that has been used keeps its history; Close is its exit.
 *
 * Routes: routes/hub.ts (GET /hub/groups/choices, POST /hub/groups, POST and DELETE /hub/groups/:id/members,
 * DELETE /hub/groups/:id). Nothing here sends anything to anyone.
 */
import type { HubThread, Prisma, PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "../lib/prisma";
import { HubError, hubAudit, memberGroupIds, personIdOf, type HubReader } from "./hub";
import { publishHubChange } from "./hubBus";
import { activeKeyWhere } from "../agentApi/keys";
import { AGENT_ROLE_LABELS, hubKindsFor, isAgentRole } from "../../shared/agentScopes";
import type { GroupChoices, GroupMemberView, GroupView } from "../../shared/hub/views";
import {
  GROUP_AGENT_CANNOT_REASON, GROUP_DRAFT_CLOSED_REASON, GROUP_DRAFT_LEFT_REASON, GROUP_HAS_HISTORY_REASON,
  GROUP_MEMBER_MAX, GROUP_NAME_MAX, GROUP_OFFICE_ONLY,
} from "../../shared/hub/groups";

/** Only the office (Kyle's PIN session or a CRM login) makes or changes a group; the AI admin session does not. */
export function assertOfficePerson(reader: HubReader): void {
  if (reader.kind !== "owner" && reader.kind !== "user") throw new HubError(GROUP_OFFICE_ONLY, 403);
}

const unique = (list: readonly string[] | undefined): string[] => [...new Set((list ?? []).map((s) => s.trim()).filter(Boolean))];

/**
 * Whether an agent key could see and post in a group at all: the ONE rule the hub (visibleThreadWhere) and the door (hubDoor
 * kindAllowed) both use, hubKindsFor - it needs Team replies (team:reply) and a thread-kinds list that is empty or holds group.
 * Membership alone is not enough, so the picker, the add and the Members panel all ask this.
 */
export const agentKeyCanUseGroups = (k: { scopes: readonly string[]; hubThreadKinds: readonly string[] }): boolean =>
  hubKindsFor(k.scopes, "any", k.hubThreadKinds).includes("group");

const roleLabel = (role: string): string => (isAgentRole(role) ? AGENT_ROLE_LABELS[role] : role);

/** Who can be put in a group: the people on the team and the agent keys that are switched on. For the New group chat picker. */
export async function groupChoices(reader: HubReader, db: PrismaClient = defaultPrisma): Promise<GroupChoices> {
  assertOfficePerson(reader);
  const [people, agents] = await Promise.all([
    // Names and ids only: a technician row also holds the app token.
    db.technician.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    db.agentKey.findMany({ where: activeKeyWhere(new Date()), select: { id: true, name: true, agentRole: true, scopes: true, hubThreadKinds: true }, orderBy: { name: "asc" } }),
  ]);
  return {
    people,
    agents: agents.map((a) => {
      const canJoin = agentKeyCanUseGroups(a);
      return { id: a.id, name: a.name, roleLabel: roleLabel(a.agentRole), canJoin, reason: canJoin ? null : GROUP_AGENT_CANNOT_REASON };
    }),
  };
}

interface Picks { technicianIds: string[]; agentKeyIds: string[] }

/** The picks, deduplicated, and refused unless every one is a person on the team or an agent key that is switched on. */
async function checkedPicks(input: { technicianIds?: readonly string[]; agentKeyIds?: readonly string[] }, db: PrismaClient | Prisma.TransactionClient): Promise<Picks> {
  const technicianIds = unique(input.technicianIds);
  const agentKeyIds = unique(input.agentKeyIds);
  if (technicianIds.length + agentKeyIds.length > GROUP_MEMBER_MAX) throw new HubError(`A group holds at most ${GROUP_MEMBER_MAX} members.`);
  if (technicianIds.length > 0) {
    const found = await db.technician.count({ where: { id: { in: technicianIds }, isActive: true } });
    if (found !== technicianIds.length) throw new HubError("One of those people is not on the team any more.", 400);
  }
  if (agentKeyIds.length > 0) {
    const keys = await db.agentKey.findMany({ where: { id: { in: agentKeyIds }, ...activeKeyWhere(new Date()) }, select: { scopes: true, hubThreadKinds: true } });
    if (keys.length !== agentKeyIds.length) throw new HubError("One of those agents is switched off, so it cannot be added.", 400);
    // A key that could never see or post in a group is refused here, not added as a member that looks live and is not.
    if (keys.some((k) => !agentKeyCanUseGroups(k))) throw new HubError(GROUP_AGENT_CANNOT_REASON, 400);
  }
  return { technicianIds, agentKeyIds };
}

const cleanName = (name: string | undefined): string => {
  const next = (name ?? "").trim();
  if (!next) throw new HubError("A group needs a name.");
  if (next.length > GROUP_NAME_MAX) throw new HubError(`Keep the name to ${GROUP_NAME_MAX} characters.`);
  return next;
};

/** Make a group with its first members. The audit row (group_created) commits with it. */
export async function createGroup(
  reader: HubReader, input: { name: string; technicianIds?: readonly string[]; agentKeyIds?: readonly string[] }, db: PrismaClient = defaultPrisma,
): Promise<HubThread> {
  assertOfficePerson(reader);
  const name = cleanName(input.name);
  const picks = await checkedPicks(input, db);
  const thread = await db.$transaction(async (tx) => {
    const made = await tx.hubThread.create({ data: { kind: "group", title: name } });
    await tx.hubThreadMember.createMany({
      data: [
        ...picks.technicianIds.map((technicianId) => ({ threadId: made.id, technicianId, addedBy: reader.key })),
        ...picks.agentKeyIds.map((agentKeyId) => ({ threadId: made.id, agentKeyId, addedBy: reader.key })),
      ],
    });
    await hubAudit(tx, {
      actorKey: reader.key, actorDisplay: reader.display, action: "group_created", entityType: "thread", entityId: made.id, threadId: made.id,
      afterText: name, details: { technicianIds: picks.technicianIds, agentKeyIds: picks.agentKeyIds },
    });
    return made;
  });
  publishHubChange({ type: "changed", threadId: thread.id, messageId: null });
  return thread;
}

async function groupThread(threadId: string, db: PrismaClient): Promise<HubThread> {
  const thread = await db.hubThread.findFirst({ where: { id: threadId, kind: "group" } });
  if (!thread) throw new HubError("Group not found", 404);
  return thread;
}

/** Add people and agents to a group. Someone already in it is skipped; one audit row per member actually added. */
export async function addGroupMembers(
  reader: HubReader, threadId: string, input: { technicianIds?: readonly string[]; agentKeyIds?: readonly string[] }, db: PrismaClient = defaultPrisma,
): Promise<HubThread> {
  assertOfficePerson(reader);
  const thread = await groupThread(threadId, db);
  const picks = await checkedPicks(input, db);
  if (picks.technicianIds.length + picks.agentKeyIds.length === 0) throw new HubError("Pick at least one person or agent to add.");
  await db.$transaction(async (tx) => {
    const existing = await tx.hubThreadMember.findMany({ where: { threadId }, select: { technicianId: true, agentKeyId: true } });
    const haveTech = new Set(existing.flatMap((m) => (m.technicianId ? [m.technicianId] : [])));
    const haveAgent = new Set(existing.flatMap((m) => (m.agentKeyId ? [m.agentKeyId] : [])));
    const newTech = picks.technicianIds.filter((id) => !haveTech.has(id));
    const newAgent = picks.agentKeyIds.filter((id) => !haveAgent.has(id));
    if (existing.length + newTech.length + newAgent.length > GROUP_MEMBER_MAX) throw new HubError(`A group holds at most ${GROUP_MEMBER_MAX} members.`);
    const [techs, keys] = await Promise.all([
      newTech.length ? tx.technician.findMany({ where: { id: { in: newTech } }, select: { id: true, name: true } }) : [],
      newAgent.length ? tx.agentKey.findMany({ where: { id: { in: newAgent } }, select: { id: true, name: true } }) : [],
    ]);
    await tx.hubThreadMember.createMany({
      data: [
        ...newTech.map((technicianId) => ({ threadId, technicianId, addedBy: reader.key })),
        ...newAgent.map((agentKeyId) => ({ threadId, agentKeyId, addedBy: reader.key })),
      ],
      skipDuplicates: true,
    });
    for (const t of techs) {
      await hubAudit(tx, {
        actorKey: reader.key, actorDisplay: reader.display, action: "group_member_added", entityType: "thread", entityId: threadId, threadId,
        afterText: t.name, details: { technicianId: t.id },
      });
    }
    for (const k of keys) {
      await hubAudit(tx, {
        actorKey: reader.key, actorDisplay: reader.display, action: "group_member_added", entityType: "thread", entityId: threadId, threadId,
        afterText: k.name, details: { agentKeyId: k.id },
      });
    }
  });
  publishHubChange({ type: "changed", threadId, messageId: null });
  return thread;
}

/**
 * Take a person or an agent out of a group, with the audit. From that moment they no longer see the group: it leaves their
 * Messages list, their live stream, their push and their unread count (every one asks visibleThreadWhere, and the member row
 * is what it asks). Their old messages stay in the group.
 */
export async function removeGroupMember(
  reader: HubReader, threadId: string, input: { technicianId?: string; agentKeyId?: string }, db: PrismaClient = defaultPrisma,
): Promise<HubThread> {
  assertOfficePerson(reader);
  const thread = await groupThread(threadId, db);
  const technicianId = input.technicianId?.trim() || undefined;
  const agentKeyId = input.agentKeyId?.trim() || undefined;
  if (Boolean(technicianId) === Boolean(agentKeyId)) throw new HubError("Say which member to remove: one person or one agent.");
  const name = technicianId
    ? (await db.technician.findUnique({ where: { id: technicianId }, select: { name: true } }))?.name
    : (await db.agentKey.findUnique({ where: { id: agentKeyId! }, select: { name: true } }))?.name;
  await db.$transaction(async (tx) => {
    const gone = await tx.hubThreadMember.deleteMany({ where: { threadId, ...(technicianId ? { technicianId } : { agentKeyId }) } });
    if (gone.count === 0) throw new HubError("That member is not in this group.", 404);
    await hubAudit(tx, {
      actorKey: reader.key, actorDisplay: reader.display, action: "group_member_removed", entityType: "thread", entityId: threadId, threadId,
      beforeText: name ?? null, details: technicianId ? { technicianId } : { agentKeyId },
    });
    // A person taken out of the group can no longer reach a photo they added and did not send (the group left their list, so
    // their Remove answers 404, and no office screen lists another person's held photos). Taking them back here keeps every
    // held photo with an exit (Kyle's nothing-permanent rule). Agents never add photos, so only a person has any.
    if (technicianId) {
      const held = await tx.hubAttachment.findMany({ where: { threadId, messageId: null, deletedAt: null, technicianId }, select: { id: true } });
      if (held.length > 0) {
        await tx.hubAttachment.updateMany({ where: { id: { in: held.map((h) => h.id) } }, data: { deletedAt: new Date() } });
        for (const h of held) {
          await hubAudit(tx, {
            actorKey: reader.key, actorDisplay: reader.display, action: "attachment_removed", entityType: "attachment",
            entityId: h.id, threadId, details: { reason: "member removed from group" },
          });
        }
      }
    }
  });
  publishHubChange({ type: "changed", threadId, messageId: null });
  return thread;
}

/**
 * Delete a group, only while nothing has ever been said in it (not even a message that was later deleted: those rows are
 * history). The delete itself refuses a thread that gained a message in the meantime. A used group's exit is Close.
 */
export async function deleteGroup(reader: HubReader, threadId: string, db: PrismaClient = defaultPrisma): Promise<void> {
  assertOfficePerson(reader);
  const thread = await groupThread(threadId, db);
  if ((await db.hubMessage.count({ where: { threadId } })) > 0) throw new HubError(GROUP_HAS_HISTORY_REASON, 409);
  const members = await db.hubThreadMember.count({ where: { threadId } });
  await db.$transaction(async (tx) => {
    const gone = await tx.hubThread.deleteMany({ where: { id: threadId, kind: "group", messages: { none: {} } } });
    if (gone.count === 0) throw new HubError(GROUP_HAS_HISTORY_REASON, 409);
    await hubAudit(tx, {
      actorKey: reader.key, actorDisplay: reader.display, action: "group_deleted", entityType: "thread", entityId: threadId, threadId,
      beforeText: thread.title, details: { members },
    });
  });
  // The thread is gone, so a live event naming it would never reach anyone (visibility is asked of the database): the
  // screens that had it listed pick the change up at their next refresh.
}

/** What the Thread drawer shows of a group: its members, and whether Delete group is live or greyed (with the reason). */
export async function groupView(reader: HubReader, thread: HubThread, db: PrismaClient = defaultPrisma): Promise<GroupView> {
  const [rows, messageCount, meId, mine] = await Promise.all([
    db.hubThreadMember.findMany({ where: { threadId: thread.id }, orderBy: { addedAt: "asc" } }),
    db.hubMessage.count({ where: { threadId: thread.id } }),
    personIdOf(reader, db),
    memberGroupIds(reader, [thread.id], db),
  ]);
  const techIds = rows.flatMap((m) => (m.technicianId ? [m.technicianId] : []));
  const keyIds = rows.flatMap((m) => (m.agentKeyId ? [m.agentKeyId] : []));
  const now = new Date();
  const [techs, keys] = await Promise.all([
    techIds.length ? db.technician.findMany({ where: { id: { in: techIds } }, select: { id: true, name: true, isActive: true } }) : [],
    keyIds.length ? db.agentKey.findMany({ where: { id: { in: keyIds } }, select: { id: true, name: true, agentRole: true, scopes: true, hubThreadKinds: true, revokedAt: true, expiresAt: true, retiresAt: true } }) : [],
  ]);
  const techById = new Map(techs.map((t) => [t.id, t]));
  const keyById = new Map(keys.map((k) => [k.id, k]));
  const members: GroupMemberView[] = rows.map((m) => {
    if (m.technicianId) {
      const t = techById.get(m.technicianId);
      return { kind: "person", id: m.technicianId, name: t?.name ?? "Former team member", roleLabel: null, addedAt: m.addedAt.toISOString(), you: m.technicianId === meId, active: t?.isActive ?? false, reason: t?.isActive === false ? "no longer on the team" : null };
    }
    const k = m.agentKeyId ? keyById.get(m.agentKeyId) : undefined;
    const on = Boolean(k && !k.revokedAt && (!k.expiresAt || k.expiresAt > now) && (!k.retiresAt || k.retiresAt > now));
    // Switched off, or on but unable to reach a group (its scopes or thread kinds changed after it was added): either way it is
    // not a working member, and the panel says which instead of showing a live-looking name.
    const reach = Boolean(k && agentKeyCanUseGroups(k));
    const reason = !on ? "switched off" : !reach ? GROUP_AGENT_CANNOT_REASON : null;
    return { kind: "agent", id: m.agentKeyId ?? "", name: k?.name ?? "Removed agent", roleLabel: k ? roleLabel(k.agentRole) : null, addedAt: m.addedAt.toISOString(), you: false, active: on && reach, reason };
  });
  return {
    members, messageCount, youAreMember: mine.has(thread.id),
    canDelete: messageCount === 0, deleteReason: messageCount === 0 ? null : GROUP_HAS_HISTORY_REASON,
  };
}

/**
 * Why a draft left in a group cannot be approved now, or null. A closed group takes no post (a message never reopens it), and a draft
 * whose agent has since been taken out of the group is not posted under an agent that no longer belongs. Reject stays open as the exit.
 * Asked by both decisions (hubApproval approve and edit-approve) and by the approval card, so the button is greyed with this very
 * sentence instead of failing on a click.
 */
export async function groupDraftBlock(
  thread: Pick<HubThread, "id" | "kind" | "status">, message: { authorBotKeyId: string | null }, db: PrismaClient | Prisma.TransactionClient = defaultPrisma,
): Promise<string | null> {
  if (thread.kind !== "group") return null;
  if (thread.status === "closed") return GROUP_DRAFT_CLOSED_REASON;
  if (message.authorBotKeyId && !(await db.hubThreadMember.findFirst({ where: { threadId: thread.id, agentKeyId: message.authorBotKeyId }, select: { id: true } }))) {
    return GROUP_DRAFT_LEFT_REASON;
  }
  return null;
}
