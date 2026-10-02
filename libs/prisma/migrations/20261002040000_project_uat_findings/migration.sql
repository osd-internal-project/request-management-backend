-- CreateTable
CREATE TABLE "project_uat_findings" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "severity" TEXT NOT NULL,
    "testItemId" TEXT,
    "reportedBy" TEXT,
    "reportedOn" DATE NOT NULL,
    "ownerUserId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "fixNote" TEXT,
    "fixedAt" TIMESTAMP(3),
    "fixedBy" TEXT,
    "confirmedByName" TEXT,
    "confirmedOn" DATE,
    "deferReason" TEXT,
    "reopenNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "project_uat_findings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_uat_findings_projectId_status_idx" ON "project_uat_findings"("projectId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "project_uat_findings_projectId_seq_key" ON "project_uat_findings"("projectId", "seq");

-- AddForeignKey
ALTER TABLE "project_uat_findings" ADD CONSTRAINT "project_uat_findings_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

