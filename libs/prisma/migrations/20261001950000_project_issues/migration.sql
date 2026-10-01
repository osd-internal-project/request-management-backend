-- CreateTable
CREATE TABLE "project_issues" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "severity" TEXT NOT NULL DEFAULT 'medium',
    "scheduleImpactDays" INTEGER NOT NULL DEFAULT 0,
    "costImpact" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "ownerUserId" TEXT NOT NULL,
    "dueOn" DATE NOT NULL,
    "taskId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "resolution" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "changeRequestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "project_issues_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_issues_companyId_status_dueOn_idx" ON "project_issues"("companyId", "status", "dueOn");

-- CreateIndex
CREATE UNIQUE INDEX "project_issues_projectId_seq_key" ON "project_issues"("projectId", "seq");

-- AddForeignKey
ALTER TABLE "project_issues" ADD CONSTRAINT "project_issues_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

