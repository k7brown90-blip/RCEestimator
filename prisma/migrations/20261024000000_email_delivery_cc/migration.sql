-- AlterTable
ALTER TABLE "EmailDelivery" ADD COLUMN     "cc" TEXT[] DEFAULT ARRAY[]::TEXT[];
