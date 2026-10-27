-- CreateTable
CREATE TABLE "agent_records" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'processing',
    "input" JSONB NOT NULL,
    "result" JSONB,
    "error" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_records_companyId_createdAt_idx" ON "agent_records"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "agent_records_companyId_action_status_idx" ON "agent_records"("companyId", "action", "status");

