-- AlterTable
ALTER TABLE "crm_company_configs" ADD COLUMN     "projectTechChangeTypeCode" TEXT;

-- CreateTable
CREATE TABLE "project_tech_changes" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "reason" TEXT,
    "description" TEXT,
    "boqLines" JSONB NOT NULL DEFAULT '[]',
    "costChange" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "affectsScope" BOOLEAN NOT NULL DEFAULT false,
    "scopeAdded" TEXT,
    "scopeRemoved" TEXT,
    "changeRequestId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "requestId" TEXT,
    "error" TEXT,
    "submittedAt" TIMESTAMP(3),
    "submittedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "appliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "project_tech_changes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_tech_changes_requestId_idx" ON "project_tech_changes"("requestId");

-- CreateIndex
CREATE UNIQUE INDEX "project_tech_changes_projectId_seq_key" ON "project_tech_changes"("projectId", "seq");

-- AddForeignKey
ALTER TABLE "project_tech_changes" ADD CONSTRAINT "project_tech_changes_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

