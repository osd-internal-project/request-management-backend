-- CD-265 (CD-22 KBMS) — ช่องทางให้ AI ดึงความรู้ไปตอบ: การค้นและการอ้างอิง.
-- CreateTable
CREATE TABLE "kb_ai_queries" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "conversationRef" TEXT,
    "customerId" TEXT,
    "question" TEXT,
    "results" JSONB NOT NULL DEFAULT '[]',
    "outcome" TEXT NOT NULL DEFAULT 'pending',
    "answer" TEXT,
    "answeredAt" TIMESTAMP(3),
    "textPurgedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kb_ai_queries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kb_ai_citations" (
    "queryId" TEXT NOT NULL,
    "articleId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kb_ai_citations_pkey" PRIMARY KEY ("queryId","articleId")
);

-- CreateIndex
CREATE INDEX "kb_ai_queries_companyId_createdAt_idx" ON "kb_ai_queries"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "kb_ai_queries_companyId_outcome_idx" ON "kb_ai_queries"("companyId", "outcome");

-- CreateIndex
CREATE INDEX "kb_ai_citations_articleId_idx" ON "kb_ai_citations"("articleId");

