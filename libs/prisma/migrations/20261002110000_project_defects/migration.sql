-- CreateTable
CREATE TABLE "project_defects" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "severity" TEXT NOT NULL,
    "sowRef" TEXT NOT NULL,
    "taskId" TEXT,
    "foundOn" DATE NOT NULL,
    "assigneeUserId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "fixNote" TEXT,
    "fixedAt" TIMESTAMP(3),
    "fixedBy" TEXT,
    "verifyNote" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "verifiedBy" TEXT,
    "reopenNote" TEXT,
    "cancelNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "project_defects_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_defects_projectId_status_idx" ON "project_defects"("projectId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "project_defects_projectId_seq_key" ON "project_defects"("projectId", "seq");

-- AddForeignKey
ALTER TABLE "project_defects" ADD CONSTRAINT "project_defects_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

