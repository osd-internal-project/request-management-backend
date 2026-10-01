-- CreateTable
CREATE TABLE "project_progress_reports" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "reportedPct" DECIMAL(5,2) NOT NULL,
    "computedPct" DECIMAL(5,2) NOT NULL,
    "plannedPct" DECIMAL(5,2),
    "reason" TEXT,
    "note" TEXT,
    "reportedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reportedBy" TEXT NOT NULL,

    CONSTRAINT "project_progress_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_progress_reports_projectId_reportedAt_idx" ON "project_progress_reports"("projectId", "reportedAt");

-- AddForeignKey
ALTER TABLE "project_progress_reports" ADD CONSTRAINT "project_progress_reports_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

