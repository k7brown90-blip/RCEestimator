/*
  Warnings:

  - A unique constraint covering the columns `[employeeNumber]` on the table `Technician` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Technician" ADD COLUMN     "employeeNumber" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Technician_employeeNumber_key" ON "Technician"("employeeNumber");
