-- CreateTable
CREATE TABLE "project_milestones" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "criteria" JSONB NOT NULL DEFAULT '[]',
    "dueOn" DATE,
    "installmentId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'planned',
    "achievedOn" DATE,
    "achievedAt" TIMESTAMP(3),
    "achievedBy" TEXT,
    "evidenceNote" TEXT,
    "evidenceKey" TEXT,
    "evidenceName" TEXT,
    "evidenceMime" TEXT,
    "evidenceSize" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "project_milestones_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "project_milestones_installmentId_key" ON "project_milestones"("installmentId");

-- CreateIndex
CREATE INDEX "project_milestones_projectId_seq_idx" ON "project_milestones"("projectId", "seq");

-- CreateIndex
CREATE INDEX "project_milestones_companyId_status_dueOn_idx" ON "project_milestones"("companyId", "status", "dueOn");

-- AddForeignKey
ALTER TABLE "project_milestones" ADD CONSTRAINT "project_milestones_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_milestones" ADD CONSTRAINT "project_milestones_installmentId_fkey" FOREIGN KEY ("installmentId") REFERENCES "contract_installments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

