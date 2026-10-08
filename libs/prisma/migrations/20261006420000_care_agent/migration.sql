-- CD-284 (CD-23 AI CARE) — a service team member holding a conversation, and
-- the delivery of messages that must still reach the customer (an outbox the
-- channel connectors read; LINE is pushed directly).

-- AlterTable
ALTER TABLE "care_conversations" ADD COLUMN     "agentSince" TIMESTAMP(3),
ADD COLUMN     "agentUserId" TEXT;

-- AlterTable
ALTER TABLE "care_messages" ADD COLUMN     "deliveredAt" TIMESTAMP(3),
ADD COLUMN     "delivery" TEXT,
ADD COLUMN     "deliveryAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "deliveryError" TEXT;

-- CreateIndex
CREATE INDEX "care_messages_delivery_createdAt_idx" ON "care_messages"("delivery", "createdAt");

