-- AlterEnum
ALTER TYPE "NotificationChannel" ADD VALUE 'teams';

-- AlterTable
ALTER TABLE "notification_delivery_logs" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "nextAttemptAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "notification_preferences" ADD COLUMN     "teamsEnabled" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "teams_chat_links" (
    "userId" TEXT NOT NULL,
    "aadObjectId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "teams_chat_links_pkey" PRIMARY KEY ("userId")
);

-- CreateIndex
CREATE INDEX "notification_delivery_logs_channel_status_nextAttemptAt_idx" ON "notification_delivery_logs"("channel", "status", "nextAttemptAt");

