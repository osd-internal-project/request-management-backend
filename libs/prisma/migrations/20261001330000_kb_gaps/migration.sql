-- CD-266 (CD-22 KBMS) — ช่องว่างความรู้.
-- AlterTable
ALTER TABLE "kb_ai_queries" ADD COLUMN     "gapId" TEXT;

-- CreateTable
CREATE TABLE "kb_gaps" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "articleId" TEXT,
    "articleVersion" INTEGER,
    "baseYes" INTEGER NOT NULL DEFAULT 0,
    "baseNo" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'open',
    "assigneeId" TEXT,
    "dueOn" DATE,
    "assignedBy" TEXT,
    "assignedAt" TIMESTAMP(3),
    "resolutionArticleId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "dismissReason" TEXT,
    "remindedOn" DATE,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kb_gaps_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "kb_gaps_companyId_status_idx" ON "kb_gaps"("companyId", "status");

-- CreateIndex
CREATE INDEX "kb_gaps_assigneeId_status_idx" ON "kb_gaps"("assigneeId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "kb_gaps_companyId_kind_key_key" ON "kb_gaps"("companyId", "kind", "key");

