-- AlterTable
ALTER TABLE "HubMessage" ADD COLUMN     "clientMessageId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "HubMessage_authorKey_clientMessageId_key" ON "HubMessage"("authorKey", "clientMessageId");

