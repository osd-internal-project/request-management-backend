-- AlterTable
ALTER TABLE "crm_company_configs" ADD COLUMN     "deliveryDocuments" JSONB NOT NULL DEFAULT '{}';

-- CreateTable
CREATE TABLE "project_delivery_documents" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "milestoneId" TEXT NOT NULL,
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

    CONSTRAINT "project_delivery_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_delivery_documents_projectId_milestoneId_idx" ON "project_delivery_documents"("projectId", "milestoneId");

