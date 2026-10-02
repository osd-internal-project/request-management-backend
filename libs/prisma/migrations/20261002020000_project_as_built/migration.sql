-- AlterTable
ALTER TABLE "crm_company_configs" ADD COLUMN     "projectAsBuiltDocuments" TEXT[] DEFAULT ARRAY['แบบติดตั้งจริง', 'รายการอุปกรณ์และหมายเลขเครื่อง', 'ผังการเชื่อมต่อระบบ']::TEXT[];

-- CreateTable
CREATE TABLE "project_as_built_documents" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "note" TEXT,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "uploadedBy" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "project_as_built_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_as_built_deviations" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "reference" TEXT,
    "planned" TEXT NOT NULL,
    "built" TEXT NOT NULL,
    "reason" TEXT,
    "affectsScope" BOOLEAN NOT NULL DEFAULT false,
    "changeRequestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "project_as_built_deviations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_as_built_documents_projectId_idx" ON "project_as_built_documents"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "project_as_built_deviations_projectId_seq_key" ON "project_as_built_deviations"("projectId", "seq");

-- AddForeignKey
ALTER TABLE "project_as_built_documents" ADD CONSTRAINT "project_as_built_documents_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_as_built_deviations" ADD CONSTRAINT "project_as_built_deviations_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

