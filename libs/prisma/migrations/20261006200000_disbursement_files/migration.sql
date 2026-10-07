-- การเบิก as the ticket's work screen: step codes it works, and evidence files. Additive only.

-- AlterTable
ALTER TABLE "disbursement_settings" ADD COLUMN     "clearStep" TEXT,
ADD COLUMN     "doneStep" TEXT,
ADD COLUMN     "execStep" TEXT,
ADD COLUMN     "payStep" TEXT,
ADD COLUMN     "verifyStep" TEXT;

-- CreateTable
CREATE TABLE "disbursement_files" (
    "id" TEXT NOT NULL,
    "disbursementId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "uploadedBy" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "disbursement_files_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "disbursement_files_disbursementId_idx" ON "disbursement_files"("disbursementId");

