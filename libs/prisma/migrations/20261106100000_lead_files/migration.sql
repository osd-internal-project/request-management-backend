-- ไฟล์บน Lead (6 พ.ย. 2569): proposal ที่ Vuvagent/เซลล์วางไว้ แนบไปกับอีเมลขอบคุณ
CREATE TABLE "lead_files" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'other',
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'user',
    "uploadedBy" TEXT,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "lead_files_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "lead_files_leadId_kind_uploadedAt_idx" ON "lead_files"("leadId", "kind", "uploadedAt");
CREATE INDEX "lead_files_companyId_idx" ON "lead_files"("companyId");

ALTER TABLE "lead_files" ADD CONSTRAINT "lead_files_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
