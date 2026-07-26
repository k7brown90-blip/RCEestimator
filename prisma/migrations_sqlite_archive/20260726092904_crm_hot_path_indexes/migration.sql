-- CreateIndex
CREATE INDEX "Customer_phone_idx" ON "Customer"("phone");

-- CreateIndex
CREATE INDEX "Lead_customerId_idx" ON "Lead"("customerId");

-- CreateIndex
CREATE INDEX "Lead_leadStatus_followUpDate_idx" ON "Lead"("leadStatus", "followUpDate");

-- CreateIndex
CREATE INDEX "Lead_phone_idx" ON "Lead"("phone");

-- CreateIndex
CREATE INDEX "Lead_createdAt_idx" ON "Lead"("createdAt");

-- CreateIndex
CREATE INDEX "Visit_customerId_visitDate_idx" ON "Visit"("customerId", "visitDate");

-- CreateIndex
CREATE INDEX "Visit_status_scheduledStart_idx" ON "Visit"("status", "scheduledStart");
