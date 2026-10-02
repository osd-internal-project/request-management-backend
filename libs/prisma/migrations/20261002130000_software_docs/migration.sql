-- AlterTable
ALTER TABLE "crm_company_configs" ADD COLUMN     "projectSoftwareDocuments" TEXT[] DEFAULT ARRAY['ข้อกำหนดซอฟต์แวร์', 'คู่มือผู้ใช้', 'คู่มือผู้ดูแลระบบ', 'เอกสารจุดเชื่อมต่อ (API)']::TEXT[];

-- CreateTable
CREATE TABLE "project_software_documents" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "releaseId" TEXT NOT NULL,
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

    CONSTRAINT "project_software_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_software_documents_projectId_releaseId_idx" ON "project_software_documents"("projectId", "releaseId");

-- AddForeignKey
ALTER TABLE "project_software_documents" ADD CONSTRAINT "project_software_documents_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_software_documents" ADD CONSTRAINT "project_software_documents_releaseId_fkey" FOREIGN KEY ("releaseId") REFERENCES "project_releases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

