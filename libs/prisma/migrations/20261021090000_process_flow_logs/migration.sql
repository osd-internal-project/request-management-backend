-- CreateTable
CREATE TABLE "process_flow_logs" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "eventId" TEXT,
    "instanceId" TEXT NOT NULL,
    "workflowKey" TEXT NOT NULL,
    "stageNo" INTEGER NOT NULL,
    "stageCode" TEXT NOT NULL,
    "teamCode" TEXT,
    "stepCode" TEXT NOT NULL,
    "stepName" TEXT,
    "status" TEXT NOT NULL,
    "decision" TEXT,
    "refType" TEXT,
    "refNo" TEXT,
    "actorEmail" TEXT,
    "actorName" TEXT,
    "comment" TEXT,
    "payload" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "apiKeyPrefix" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "process_flow_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "process_flow_logs_companyId_eventId_key" ON "process_flow_logs"("companyId", "eventId");

-- CreateIndex
CREATE INDEX "process_flow_logs_companyId_occurredAt_idx" ON "process_flow_logs"("companyId", "occurredAt");

-- CreateIndex
CREATE INDEX "process_flow_logs_companyId_instanceId_idx" ON "process_flow_logs"("companyId", "instanceId");

-- CreateIndex
CREATE INDEX "process_flow_logs_companyId_stageNo_idx" ON "process_flow_logs"("companyId", "stageNo");

-- CreateIndex
CREATE INDEX "process_flow_logs_companyId_refNo_idx" ON "process_flow_logs"("companyId", "refNo");
