-- CD-275 (CD-24) — LLM Gateway: model per task, quotas, prices, and the call log.
-- CreateTable
CREATE TABLE "llm_task_settings" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "task" TEXT NOT NULL,
    "model" TEXT,
    "monthlyTokenQuota" INTEGER,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "llm_task_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "llm_model_prices" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputPer1k" DECIMAL(12,4) NOT NULL,
    "outputPer1k" DECIMAL(12,4) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "llm_model_prices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "llm_calls" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "userId" TEXT,
    "task" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "costEstimate" DECIMAL(12,4),
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "llm_calls_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "llm_task_settings_companyId_task_key" ON "llm_task_settings"("companyId", "task");

-- CreateIndex
CREATE UNIQUE INDEX "llm_model_prices_companyId_model_key" ON "llm_model_prices"("companyId", "model");

-- CreateIndex
CREATE INDEX "llm_calls_companyId_createdAt_idx" ON "llm_calls"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "llm_calls_companyId_task_createdAt_idx" ON "llm_calls"("companyId", "task", "createdAt");

