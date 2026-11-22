-- CreateTable
CREATE TABLE "HubPushSubscription" (
    "id" TEXT NOT NULL,
    "readerKey" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastOkAt" TIMESTAMP(3),
    "lastError" TEXT,

    CONSTRAINT "HubPushSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "HubPushSubscription_endpoint_key" ON "HubPushSubscription"("endpoint");

-- CreateIndex
CREATE INDEX "HubPushSubscription_readerKey_idx" ON "HubPushSubscription"("readerKey");

