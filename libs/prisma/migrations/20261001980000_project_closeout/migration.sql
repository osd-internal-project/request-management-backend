-- AlterTable
ALTER TABLE "crm_company_configs" ADD COLUMN     "projectCloseDocuments" TEXT[] DEFAULT ARRAY['ใบตรวจรับงาน', 'เอกสารส่งมอบงาน']::TEXT[],
ADD COLUMN     "projectCloseTypeCode" TEXT;

-- CreateTable
CREATE TABLE "project_closeouts" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "summary" TEXT,
    "requestId" TEXT,
    "error" TEXT,
    "submittedAt" TIMESTAMP(3),
    "submittedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "project_closeouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_close_documents" (
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

    CONSTRAINT "project_close_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_lessons" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "kbmsStatus" TEXT NOT NULL DEFAULT 'pending',
    "kbmsRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "project_lessons_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "project_closeouts_projectId_key" ON "project_closeouts"("projectId");

-- CreateIndex
CREATE INDEX "project_closeouts_requestId_idx" ON "project_closeouts"("requestId");

-- CreateIndex
CREATE INDEX "project_close_documents_projectId_idx" ON "project_close_documents"("projectId");

-- CreateIndex
CREATE INDEX "project_lessons_projectId_idx" ON "project_lessons"("projectId");

-- CreateIndex
CREATE INDEX "project_lessons_kbmsStatus_idx" ON "project_lessons"("kbmsStatus");

-- AddForeignKey
ALTER TABLE "project_closeouts" ADD CONSTRAINT "project_closeouts_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_close_documents" ADD CONSTRAINT "project_close_documents_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_lessons" ADD CONSTRAINT "project_lessons_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

