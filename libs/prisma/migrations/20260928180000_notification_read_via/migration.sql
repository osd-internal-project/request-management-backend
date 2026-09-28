-- CreateEnum
CREATE TYPE "NotificationReadVia" AS ENUM ('opened', 'mark_all');

-- AlterTable
ALTER TABLE "notifications" ADD COLUMN     "readVia" "NotificationReadVia";

-- CreateIndex
CREATE INDEX "notifications_companyId_createdAt_idx" ON "notifications"("companyId", "createdAt");

