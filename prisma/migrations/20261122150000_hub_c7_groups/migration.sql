-- Work order agent-team, C7: office-made group chats. ONE new table (members of a `group` hub thread); HubThread.kind is a
-- free String, so the new kind needs no column. A member is a person (Technician.id) or an agent (AgentKey.id, by value,
-- no foreign key): exactly one is set (the CHECK below; the service refuses anything else too).
-- CreateTable
CREATE TABLE "HubThreadMember" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "technicianId" TEXT,
    "agentKeyId" TEXT,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "addedBy" TEXT NOT NULL,

    CONSTRAINT "HubThreadMember_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HubThreadMember_technicianId_idx" ON "HubThreadMember"("technicianId");

-- CreateIndex
CREATE INDEX "HubThreadMember_agentKeyId_idx" ON "HubThreadMember"("agentKeyId");

-- CreateIndex
CREATE UNIQUE INDEX "HubThreadMember_threadId_technicianId_key" ON "HubThreadMember"("threadId", "technicianId");

-- CreateIndex
CREATE UNIQUE INDEX "HubThreadMember_threadId_agentKeyId_key" ON "HubThreadMember"("threadId", "agentKeyId");

-- AddForeignKey
ALTER TABLE "HubThreadMember" ADD CONSTRAINT "HubThreadMember_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "HubThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HubThreadMember" ADD CONSTRAINT "HubThreadMember_technicianId_fkey" FOREIGN KEY ("technicianId") REFERENCES "Technician"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- AddCheck: exactly one of technicianId and agentKeyId
ALTER TABLE "HubThreadMember" ADD CONSTRAINT "HubThreadMember_one_member_chk" CHECK (("technicianId" IS NULL) <> ("agentKeyId" IS NULL));
