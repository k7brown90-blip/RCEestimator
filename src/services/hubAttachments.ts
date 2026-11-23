/**
 * Photos held on a hub message (work order agent-team, U5 amendment 9b): the ONE store for a photo that
 * belongs to no job - a Team or Training thread's. HubAttachment; there is no second photo table, and a
 * job thread's photo is NOT here: it is a VisitPhoto filed on that job and named by the message's photoIds
 * (Kyle's 2026-10-02 DraftPhoto ruling still governs job photos).
 *
 * The life of one: a person adds a photo to the thread (uploadAttachment: unattached, in THIS thread), then
 * sends the message that takes it (postMessage's attachmentIds). A photo added and not sent can be taken
 * back by its owner (removeAttachment). Deleting the message removes its photos with it (softDeleteMessage).
 *
 * Who may add: a person (the owner, a CRM login or a technician) who may post in that thread - the Team
 * thread rule applies, so nobody adds a photo to another person's Team thread. Who may read: anyone the one
 * visibility rule lets see the thread (readAttachment), by an authenticated fetch. Never a token in a URL.
 */
import sharp from "sharp";
import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "../lib/prisma";
import { HubError, findVisibleThread, hubAudit, postRefusal, visibleThreadWhere, type HubReader } from "./hub";
import { publishHubChange } from "./hubBus";
import type { AttachmentRef } from "../../shared/hub/views";

/** The biggest picture accepted. A phone's photo is shrunk to 1600 px first, so this is a ceiling, not a target. */
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
/** Unattached photos one person may be holding in one thread at a time (added, not yet sent). */
export const ATTACHMENT_MAX_STAGED = 6;

const MIME_BY_FORMAT: Record<string, string> = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" };

/** Team and Training threads hold a photo on the message; a job's photo is the job's. */
export const ATTACHMENT_JOB_REASON = "Photos go on a job's thread";

export async function uploadAttachment(
  reader: HubReader, threadId: string, bytes: Buffer, db: PrismaClient = defaultPrisma,
): Promise<AttachmentRef & { sizeBytes: number }> {
  if (reader.kind !== "owner" && reader.kind !== "user" && reader.kind !== "tech") {
    throw new HubError("Photos are added by people.", 403);
  }
  if (bytes.length === 0) throw new HubError("Add a picture first.");
  if (bytes.length > ATTACHMENT_MAX_BYTES) throw new HubError("That picture is over 10 MB.", 413);
  const thread = await findVisibleThread(reader, threadId, db);
  if (!thread) throw new HubError("Conversation not found", 404);
  if (thread.kind !== "team" && thread.kind !== "training") throw new HubError(`${ATTACHMENT_JOB_REASON}, not here.`, 409);
  const refusal = await postRefusal(reader, thread, db);
  if (refusal) throw new HubError(refusal, 403);
  if (thread.status === "closed") throw new HubError("This thread is closed. Reopen it to add a photo.", 409);

  // The bytes must really be a picture: the type the phone claimed is not trusted.
  let mimeType: string | undefined;
  try {
    const meta = await sharp(bytes).metadata();
    mimeType = meta.format ? MIME_BY_FORMAT[meta.format] : undefined;
  } catch {
    mimeType = undefined;
  }
  if (!mimeType) throw new HubError("That file is not a picture this app can show (use a JPEG, PNG, WebP or GIF).", 415);

  // The person who ADDED the photo owns it: on a Team thread that is the thread's own person, on a Training
  // thread it may be an office login. The column records the uploader's person (the thread's person only when
  // the uploader has none, Kyle's PIN session); the audit row below records the uploader's reader key, and THAT
  // is what "mine" is decided by (stagedPhotoIds), so a login with no person of its own still owns what it added.
  const technicianId = reader.technicianId ?? thread.technicianId ?? null;
  const staged = (await stagedPhotoIds(reader, threadId, db)).length;
  if (staged >= ATTACHMENT_MAX_STAGED) throw new HubError(`Send or remove the photos you already added (at most ${ATTACHMENT_MAX_STAGED} at a time).`, 409);

  const row = await db.$transaction(async (tx) => {
    const created = await tx.hubAttachment.create({
      data: { threadId, messageId: null, mimeType, sizeBytes: bytes.length, data: bytes, technicianId },
      select: { id: true, mimeType: true, sizeBytes: true },
    });
    await hubAudit(tx, {
      actorKey: reader.key, actorDisplay: reader.display, action: "attachment_added", entityType: "attachment",
      entityId: created.id, threadId, details: { mimeType, sizeBytes: bytes.length },
    });
    return created;
  });
  return row;
}

/**
 * The photos THIS reader added to this thread and has not sent (unattached, not removed). "Added by" is read
 * from the attachment_added audit row's actor (the reader key), never from the thread's person: an office login
 * that adds a photo to a technician's Training thread owns that photo, and the technician does not.
 */
export async function stagedPhotoIds(reader: HubReader, threadId: string, db: PrismaClient = defaultPrisma): Promise<string[]> {
  const open = await db.hubAttachment.findMany({ where: { threadId, messageId: null, deletedAt: null }, select: { id: true } });
  if (open.length === 0) return [];
  const added = await db.hubAuditLog.findMany({
    where: { action: "attachment_added", entityType: "attachment", entityId: { in: open.map((a) => a.id) }, actorKey: reader.key },
    select: { entityId: true },
  });
  const mine = new Set(added.map((a) => a.entityId));
  return open.filter((a) => mine.has(a.id)).map((a) => a.id);
}

/** The photos this reader is holding in this thread, so the thread screen can show them again with their Remove. */
export async function stagedPhotos(reader: HubReader, threadId: string, db: PrismaClient = defaultPrisma): Promise<AttachmentRef[]> {
  const ids = await stagedPhotoIds(reader, threadId, db);
  if (ids.length === 0) return [];
  return db.hubAttachment.findMany({ where: { id: { in: ids } }, select: { id: true, mimeType: true }, orderBy: { createdAt: "asc" } });
}

/**
 * Take back a photo that was added and not sent. Only the person who added it (or Kyle). A photo already
 * on a message leaves with that message's Delete instead.
 */
export async function removeAttachment(reader: HubReader, attachmentId: string, db: PrismaClient = defaultPrisma): Promise<void> {
  const row = await db.hubAttachment.findUnique({ where: { id: attachmentId }, select: { id: true, threadId: true, messageId: true, technicianId: true, deletedAt: true } });
  if (!row || !(await findVisibleThread(reader, row.threadId, db))) throw new HubError("Photo not found", 404);
  if (row.deletedAt) return;
  if (row.messageId) throw new HubError("That photo is on a message. Delete the message to remove it.", 409);
  const mine = (await stagedPhotoIds(reader, row.threadId, db)).includes(attachmentId);
  if (!mine && !reader.isKyle) throw new HubError("You can only remove a photo you added.", 403);
  await db.$transaction(async (tx) => {
    await tx.hubAttachment.update({ where: { id: attachmentId }, data: { deletedAt: new Date() } });
    await hubAudit(tx, {
      actorKey: reader.key, actorDisplay: reader.display, action: "attachment_removed", entityType: "attachment",
      entityId: attachmentId, threadId: row.threadId,
    });
  });
  publishHubChange({ type: "changed", threadId: row.threadId, messageId: null });
}

/** The picture, if this reader may see its thread and it was not removed. Null otherwise (the route answers 404). */
export async function readAttachment(
  reader: HubReader, attachmentId: string, db: PrismaClient = defaultPrisma,
): Promise<{ data: Buffer; mimeType: string } | null> {
  const row = await db.hubAttachment.findFirst({
    where: { id: attachmentId, deletedAt: null, removedAt: null, thread: { is: visibleThreadWhere(reader) } },
    select: { data: true, mimeType: true },
  });
  return row ? { data: Buffer.from(row.data), mimeType: row.mimeType } : null;
}
