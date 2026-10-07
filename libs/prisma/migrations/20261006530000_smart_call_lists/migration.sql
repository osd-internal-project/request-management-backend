-- CreateTable
CREATE TABLE "do_not_contact" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'all',
    "reason" TEXT,
    "source" TEXT NOT NULL,
    "sourceRef" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMP(3),
    "removedBy" TEXT,
    "removeReason" TEXT,

    CONSTRAINT "do_not_contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "smart_call_policies" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "windows" JSONB NOT NULL,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "minGapDays" INTEGER NOT NULL DEFAULT 3,
    "openingScript" TEXT NOT NULL,
    "optOutScript" TEXT NOT NULL,
    "certifiedBy" TEXT,
    "certifiedAt" TIMESTAMP(3),
    "certifiedNote" TEXT,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "smart_call_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "smart_call_lists" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "script" TEXT NOT NULL,
    "kbArticleIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'draft',
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "smart_call_lists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "smart_call_targets" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "listId" TEXT NOT NULL,
    "prospectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "lastOutcome" TEXT,
    "blockReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "smart_call_targets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "do_not_contact_companyId_kind_value_idx" ON "do_not_contact"("companyId", "kind", "value");

-- CreateIndex
CREATE UNIQUE INDEX "smart_call_policies_companyId_key" ON "smart_call_policies"("companyId");

-- CreateIndex
CREATE INDEX "smart_call_lists_companyId_status_idx" ON "smart_call_lists"("companyId", "status");

-- CreateIndex
CREATE INDEX "smart_call_targets_companyId_listId_status_idx" ON "smart_call_targets"("companyId", "listId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "smart_call_targets_listId_prospectId_key" ON "smart_call_targets"("listId", "prospectId");

