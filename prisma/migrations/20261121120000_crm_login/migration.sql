-- CreateTable
CREATE TABLE "CrmLogin" (
    "id" TEXT NOT NULL,
    "technicianId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT,
    "role" TEXT NOT NULL,
    "isPrincipal" BOOLEAN NOT NULL DEFAULT false,
    "powers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sessionVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmLogin_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CrmLogin_technicianId_key" ON "CrmLogin"("technicianId");

-- CreateIndex
CREATE UNIQUE INDEX "CrmLogin_username_key" ON "CrmLogin"("username");

-- AddForeignKey
ALTER TABLE "CrmLogin" ADD CONSTRAINT "CrmLogin_technicianId_fkey" FOREIGN KEY ("technicianId") REFERENCES "Technician"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

