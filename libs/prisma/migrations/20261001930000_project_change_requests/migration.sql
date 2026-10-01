-- AlterTable
ALTER TABLE "crm_company_configs" ADD COLUMN     "projectChangeTypeCode" TEXT;

-- AlterTable
ALTER TABLE "project_tasks" ADD COLUMN     "changeRequestId" TEXT;

-- CreateTable
CREATE TABLE "project_change_requests" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "scopeAdded" TEXT,
    "scopeRemoved" TEXT,
    "scheduleDays" INTEGER NOT NULL DEFAULT 0,
    "costLines" JSONB NOT NULL DEFAULT '[]',
    "costChange" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "priceChange" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "requestId" TEXT,
    "error" TEXT,
    "submittedAt" TIMESTAMP(3),
    "submittedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "budgetId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "project_change_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_change_requests_requestId_idx" ON "project_change_requests"("requestId");

-- CreateIndex
CREATE UNIQUE INDEX "project_change_requests_projectId_seq_key" ON "project_change_requests"("projectId", "seq");

-- AddForeignKey
ALTER TABLE "project_tasks" ADD CONSTRAINT "project_tasks_changeRequestId_fkey" FOREIGN KEY ("changeRequestId") REFERENCES "project_change_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_change_requests" ADD CONSTRAINT "project_change_requests_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

