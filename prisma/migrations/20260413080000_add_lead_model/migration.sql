-- CreateTable
CREATE TABLE "Lead" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "source" TEXT NOT NULL DEFAULT 'email',
    "status" TEXT NOT NULL DEFAULT 'new',
    "notes" TEXT,
    "address" TEXT,
    "jobType" TEXT,
    "customerId" TEXT,
    "propertyId" TEXT,
    "visitId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
