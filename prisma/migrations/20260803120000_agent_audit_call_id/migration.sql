-- Threads Vapi's call.id through so /vapi/end-of-call-report can check
-- whether a disposition was already logged for THIS call, independent of
-- model behavior mid-conversation.
ALTER TABLE "AgentAuditLog" ADD COLUMN IF NOT EXISTS "callId" TEXT;
CREATE INDEX IF NOT EXISTS "AgentAuditLog_action_callId_idx" ON "AgentAuditLog"("action", "callId");
