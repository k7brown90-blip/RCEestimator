-- CreateIndex
CREATE INDEX "ChatMessage_visitId_createdAt_idx" ON "ChatMessage"("visitId", "createdAt");

-- CreateIndex
CREATE INDEX "ChatMessage_sessionId_createdAt_idx" ON "ChatMessage"("sessionId", "createdAt");
