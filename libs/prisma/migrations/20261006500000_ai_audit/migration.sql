-- CreateTable
CREATE TABLE "mcp_calls" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "userId" TEXT,
    "viaServiceAccount" BOOLEAN NOT NULL DEFAULT false,
    "tool" TEXT NOT NULL,
    "isWrite" BOOLEAN NOT NULL DEFAULT false,
    "args" JSONB NOT NULL DEFAULT '{}',
    "resultIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "resultCount" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL,
    "errorCode" TEXT,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mcp_calls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_audit_policies" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "retentionDays" INTEGER NOT NULL DEFAULT 365,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_audit_policies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "mcp_calls_companyId_createdAt_idx" ON "mcp_calls"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "mcp_calls_companyId_userId_createdAt_idx" ON "mcp_calls"("companyId", "userId", "createdAt");

-- CreateIndex
CREATE INDEX "mcp_calls_companyId_tool_createdAt_idx" ON "mcp_calls"("companyId", "tool", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ai_audit_policies_companyId_key" ON "ai_audit_policies"("companyId");

-- CreateIndex
CREATE INDEX "llm_calls_companyId_userId_createdAt_idx" ON "llm_calls"("companyId", "userId", "createdAt");

