-- Email campaigns (Kyle, 2026-09-02): lists + campaigns + global suppression.
-- Ratified: leads added by hand, ALL accounts ride the default list
-- automatically (includeAllAccounts), new blog posts auto-DRAFT a campaign,
-- default list "Storm Preparedness Campaign". Unsubscribes are global and
-- permanent across every list and campaign — CAN-SPAM is not per-list.

CREATE TABLE "EmailList" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "includeAllAccounts" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EmailList_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "EmailList_name_key" ON "EmailList"("name");

CREATE TABLE "EmailListMember" (
    "id" TEXT NOT NULL,
    "listId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "leadId" TEXT,
    "customerId" TEXT,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EmailListMember_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "EmailListMember_listId_fkey" FOREIGN KEY ("listId") REFERENCES "EmailList"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "EmailListMember_listId_email_key" ON "EmailListMember"("listId", "email");
CREATE INDEX "EmailListMember_leadId_idx" ON "EmailListMember"("leadId");

CREATE TABLE "EmailCampaign" (
    "id" TEXT NOT NULL,
    "listId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    -- The composer's block stack: [{kind:"text"|"article"|"promo", ...}] — rendered
    -- server-side at preview and at send, so the two can never differ.
    "blocksJson" TEXT NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'draft', -- draft | sending | sent
    -- Set by the blog watcher when it auto-drafts from a new Sanity post.
    "sourceArticleId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "suppressedCount" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "EmailCampaign_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "EmailCampaign_listId_fkey" FOREIGN KEY ("listId") REFERENCES "EmailList"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "EmailCampaign_sourceArticleId_key" ON "EmailCampaign"("sourceArticleId");

-- Per-recipient outcome, snapshotted at send — a partial send is visible and
-- resumable, never silent.
CREATE TABLE "EmailCampaignSend" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending', -- pending | sent | failed | suppressed
    "error" TEXT,
    "sentAt" TIMESTAMP(3),
    "unsubscribeToken" TEXT NOT NULL,
    CONSTRAINT "EmailCampaignSend_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "EmailCampaignSend_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "EmailCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "EmailCampaignSend_campaignId_email_key" ON "EmailCampaignSend"("campaignId", "email");
CREATE UNIQUE INDEX "EmailCampaignSend_unsubscribeToken_key" ON "EmailCampaignSend"("unsubscribeToken");

CREATE TABLE "EmailSuppression" (
    "email" TEXT NOT NULL,
    "reason" TEXT NOT NULL DEFAULT 'unsubscribed', -- unsubscribed | bounced | manual
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EmailSuppression_pkey" PRIMARY KEY ("email")
);
