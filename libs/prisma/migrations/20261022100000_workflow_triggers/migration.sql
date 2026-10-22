-- CreateTable
CREATE TABLE "workflow_triggers" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "typeCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "channelId" TEXT NOT NULL,
    "channelKeyEnc" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workflow_triggers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_starts" (
    "id" TEXT NOT NULL,
    "triggerId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "variables" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastStatusCode" INTEGER,
    "lastError" TEXT,
    "instanceId" TEXT,
    "workflowKey" TEXT,
    "startedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_starts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "workflow_triggers_companyId_eventKey_active_idx" ON "workflow_triggers"("companyId", "eventKey", "active");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_starts_triggerId_resourceType_resourceId_key" ON "workflow_starts"("triggerId", "resourceType", "resourceId");

-- CreateIndex
CREATE INDEX "workflow_starts_status_nextAttemptAt_idx" ON "workflow_starts"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "workflow_starts_triggerId_createdAt_idx" ON "workflow_starts"("triggerId", "createdAt");

-- AddForeignKey
ALTER TABLE "workflow_starts" ADD CONSTRAINT "workflow_starts_triggerId_fkey" FOREIGN KEY ("triggerId") REFERENCES "workflow_triggers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
