-- CD-280 (CD-23 AI CARE) — conversations with customers on every channel,
-- their messages (text cleared after the retention period) and channel
-- identities confirmed to be a customer's contact.

-- CreateTable
CREATE TABLE "care_conversations" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "senderRef" TEXT NOT NULL,
    "senderName" TEXT,
    "identification" TEXT NOT NULL DEFAULT 'unknown',
    "customerId" TEXT,
    "contactId" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "verifiedBy" TEXT,
    "verifyMethod" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "outcome" TEXT,
    "messages" INTEGER NOT NULL DEFAULT 0,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "closedBy" TEXT,
    "textPurgedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "care_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "care_messages" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "author" TEXT NOT NULL,
    "authorUserId" TEXT,
    "text" TEXT,
    "attachments" JSONB NOT NULL DEFAULT '[]',
    "kbQueryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "care_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "care_identities" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "senderRef" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "verifiedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "care_identities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "care_conversations_companyId_channel_senderRef_status_idx" ON "care_conversations"("companyId", "channel", "senderRef", "status");

-- CreateIndex
CREATE INDEX "care_conversations_companyId_status_lastMessageAt_idx" ON "care_conversations"("companyId", "status", "lastMessageAt");

-- CreateIndex
CREATE INDEX "care_conversations_customerId_idx" ON "care_conversations"("customerId");

-- CreateIndex
CREATE INDEX "care_messages_conversationId_createdAt_idx" ON "care_messages"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "care_identities_contactId_idx" ON "care_identities"("contactId");

-- CreateIndex
CREATE UNIQUE INDEX "care_identities_companyId_channel_senderRef_key" ON "care_identities"("companyId", "channel", "senderRef");

