-- CD-262 (CD-22 KBMS) — ความรู้จากงานบริการที่ปิดและปัญหาราก.
-- CreateTable
CREATE TABLE "kb_candidates" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'work_order',
    "workOrderId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "requestNo" TEXT,
    "title" TEXT NOT NULL,
    "cause" TEXT NOT NULL,
    "resolution" TEXT NOT NULL,
    "productCode" TEXT,
    "groupCode" TEXT,
    "customerId" TEXT,
    "closedAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "articleId" TEXT,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "skipReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kb_candidates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kb_article_uses" (
    "articleId" TEXT NOT NULL,
    "workOrderId" TEXT NOT NULL,
    "usedBy" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kb_article_uses_pkey" PRIMARY KEY ("articleId","workOrderId")
);

-- CreateTable
CREATE TABLE "kb_problem_links" (
    "problemId" TEXT NOT NULL,
    "articleId" TEXT NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kb_problem_links_pkey" PRIMARY KEY ("problemId")
);

-- CreateIndex
CREATE INDEX "kb_candidates_companyId_status_idx" ON "kb_candidates"("companyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "kb_candidates_source_workOrderId_key" ON "kb_candidates"("source", "workOrderId");

-- CreateIndex
CREATE INDEX "kb_article_uses_workOrderId_idx" ON "kb_article_uses"("workOrderId");

-- CreateIndex
CREATE INDEX "kb_problem_links_articleId_idx" ON "kb_problem_links"("articleId");

