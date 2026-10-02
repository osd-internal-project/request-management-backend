-- AlterTable
ALTER TABLE "crm_company_configs" ADD COLUMN     "projectDesignTypeCode" TEXT;

-- CreateTable
CREATE TABLE "project_designs" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "versionNo" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "configuration" JSONB NOT NULL DEFAULT '[]',
    "solutionVersionId" TEXT,
    "differsFromSolution" BOOLEAN NOT NULL DEFAULT false,
    "differences" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "requestId" TEXT,
    "error" TEXT,
    "submittedAt" TIMESTAMP(3),
    "submittedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "project_designs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_design_files" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "designId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "uploadedBy" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "project_design_files_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_designs_requestId_idx" ON "project_designs"("requestId");

-- CreateIndex
CREATE UNIQUE INDEX "project_designs_projectId_versionNo_key" ON "project_designs"("projectId", "versionNo");

-- CreateIndex
CREATE INDEX "project_design_files_designId_idx" ON "project_design_files"("designId");

-- AddForeignKey
ALTER TABLE "project_designs" ADD CONSTRAINT "project_designs_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_design_files" ADD CONSTRAINT "project_design_files_designId_fkey" FOREIGN KEY ("designId") REFERENCES "project_designs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

