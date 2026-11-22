-- CreateTable
CREATE TABLE "HubThread" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "customerId" TEXT,
    "leadId" TEXT,
    "visitId" TEXT,
    "technicianId" TEXT,
    "phone" TEXT,
    "assignedAgent" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HubThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HubMessage" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "authorType" TEXT NOT NULL,
    "authorKey" TEXT,
    "authorTechnicianId" TEXT,
    "authorBotKeyId" TEXT,
    "authorDisplay" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "toAddress" TEXT,
    "cc" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "photoIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "category" TEXT,
    "messageClass" TEXT,
    "purposeKey" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL,
    "visitId" TEXT,
    "issuedEstimateId" TEXT,
    "editedFromId" TEXT,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "rejectedReason" TEXT,
    "emailDeliveryId" TEXT,
    "providerMessageId" TEXT,
    "error" TEXT,
    "toPhone10" TEXT,
    "sentText" TEXT,
    "footerIncluded" BOOLEAN NOT NULL DEFAULT false,
    "headerAt" TIMESTAMP(3),
    "eventStart" TIMESTAMP(3),
    "eventEnd" TIMESTAMP(3),
    "actionKind" TEXT,
    "actionPayloadJson" TEXT,
    "sendAfter" TIMESTAMP(3),
    "claimedAt" TIMESTAMP(3),
    "heldReason" TEXT,
    "lastNotifiedAt" TIMESTAMP(3),
    "notifyCount" INTEGER NOT NULL DEFAULT 0,
    "editedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,
    "deletedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),

    CONSTRAINT "HubMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HubReadState" (
    "readerKey" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "lastReadAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HubReadState_pkey" PRIMARY KEY ("readerKey","threadId")
);

-- CreateTable
CREATE TABLE "HubAuditLog" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorKey" TEXT NOT NULL,
    "actorDisplay" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "threadId" TEXT,
    "messageId" TEXT,
    "agentAuditLogId" TEXT,
    "beforeText" TEXT,
    "afterText" TEXT,
    "detailsJson" TEXT,

    CONSTRAINT "HubAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HubAttachment" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "messageId" TEXT,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "technicianId" TEXT,
    "botKeyId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),
    "removedAt" TIMESTAMP(3),
    "removedReason" TEXT,

    CONSTRAINT "HubAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HubEvent" (
    "id" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payloadJson" TEXT NOT NULL,
    "target" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "lastError" TEXT,
    "lastStatusCode" INTEGER,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HubEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HubEventAttempt" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "statusCode" INTEGER,
    "error" TEXT,
    "ms" INTEGER,

    CONSTRAINT "HubEventAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HubThread_phone_idx" ON "HubThread"("phone");

-- CreateIndex
CREATE INDEX "HubThread_kind_lastMessageAt_idx" ON "HubThread"("kind", "lastMessageAt");

-- CreateIndex
CREATE UNIQUE INDEX "HubThread_kind_customerId_key" ON "HubThread"("kind", "customerId");

-- CreateIndex
CREATE UNIQUE INDEX "HubThread_kind_leadId_key" ON "HubThread"("kind", "leadId");

-- CreateIndex
CREATE UNIQUE INDEX "HubThread_kind_visitId_key" ON "HubThread"("kind", "visitId");

-- CreateIndex
CREATE UNIQUE INDEX "HubThread_kind_technicianId_key" ON "HubThread"("kind", "technicianId");

-- CreateIndex
CREATE UNIQUE INDEX "HubMessage_emailDeliveryId_key" ON "HubMessage"("emailDeliveryId");

-- CreateIndex
CREATE UNIQUE INDEX "HubMessage_providerMessageId_key" ON "HubMessage"("providerMessageId");

-- CreateIndex
CREATE INDEX "HubMessage_threadId_createdAt_idx" ON "HubMessage"("threadId", "createdAt");

-- CreateIndex
CREATE INDEX "HubMessage_status_createdAt_idx" ON "HubMessage"("status", "createdAt");

-- CreateIndex
CREATE INDEX "HubMessage_channel_toPhone10_status_idx" ON "HubMessage"("channel", "toPhone10", "status");

-- CreateIndex
CREATE INDEX "HubAuditLog_threadId_at_idx" ON "HubAuditLog"("threadId", "at");

-- CreateIndex
CREATE INDEX "HubAuditLog_actorKey_at_idx" ON "HubAuditLog"("actorKey", "at");

-- CreateIndex
CREATE INDEX "HubAuditLog_entityType_entityId_idx" ON "HubAuditLog"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "HubAttachment_threadId_idx" ON "HubAttachment"("threadId");

-- CreateIndex
CREATE INDEX "HubAttachment_messageId_idx" ON "HubAttachment"("messageId");

-- CreateIndex
CREATE INDEX "HubEvent_status_nextAttemptAt_idx" ON "HubEvent"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "HubEvent_type_createdAt_idx" ON "HubEvent"("type", "createdAt");

-- CreateIndex
CREATE INDEX "HubEvent_eventKey_idx" ON "HubEvent"("eventKey");

-- CreateIndex
CREATE INDEX "HubEventAttempt_eventId_at_idx" ON "HubEventAttempt"("eventId", "at");

-- AddForeignKey
ALTER TABLE "HubThread" ADD CONSTRAINT "HubThread_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HubThread" ADD CONSTRAINT "HubThread_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HubThread" ADD CONSTRAINT "HubThread_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "Visit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HubThread" ADD CONSTRAINT "HubThread_technicianId_fkey" FOREIGN KEY ("technicianId") REFERENCES "Technician"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HubMessage" ADD CONSTRAINT "HubMessage_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "HubThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HubMessage" ADD CONSTRAINT "HubMessage_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "Visit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HubMessage" ADD CONSTRAINT "HubMessage_issuedEstimateId_fkey" FOREIGN KEY ("issuedEstimateId") REFERENCES "IssuedEstimate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HubMessage" ADD CONSTRAINT "HubMessage_editedFromId_fkey" FOREIGN KEY ("editedFromId") REFERENCES "HubMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HubMessage" ADD CONSTRAINT "HubMessage_emailDeliveryId_fkey" FOREIGN KEY ("emailDeliveryId") REFERENCES "EmailDelivery"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HubReadState" ADD CONSTRAINT "HubReadState_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "HubThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HubAttachment" ADD CONSTRAINT "HubAttachment_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "HubThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HubAttachment" ADD CONSTRAINT "HubAttachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "HubMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HubEventAttempt" ADD CONSTRAINT "HubEventAttempt_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "HubEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- Append-only hub audit (work order agent-team, U1): the database refuses to change or remove a
-- HubAuditLog row. This block is hand-written, not from the schema diff. tests/globalSetup.ts runs
-- the same block (db push never runs migration SQL), so the tests exercise the real trigger.
-- BEGIN append-only trigger
CREATE OR REPLACE FUNCTION "hub_audit_log_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'HubAuditLog is append-only: % is not allowed', TG_OP USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "HubAuditLog_append_only" BEFORE UPDATE OR DELETE ON "HubAuditLog"
FOR EACH ROW EXECUTE FUNCTION "hub_audit_log_append_only"();
-- END append-only trigger
