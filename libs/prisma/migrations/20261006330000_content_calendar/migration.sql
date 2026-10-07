-- CD-271 (CD-15 MACOM) — content calendar: one post on one channel, with its media.
-- CreateTable
CREATE TABLE "content_items" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "campaignId" TEXT,
    "channel" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "caption" TEXT NOT NULL DEFAULT '',
    "ownerUserId" TEXT NOT NULL,
    "plannedAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "publishedAt" TIMESTAMP(3),
    "publishedUrl" TEXT,
    "cancelReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "remindedAt" TIMESTAMP(3),
    "overdueAt" TIMESTAMP(3),
    "copiedFromId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "content_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_files" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "contentId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "uploadedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMP(3),

    CONSTRAINT "content_files_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "content_items_companyId_plannedAt_idx" ON "content_items"("companyId", "plannedAt");

-- CreateIndex
CREATE INDEX "content_items_companyId_status_idx" ON "content_items"("companyId", "status");

-- CreateIndex
CREATE INDEX "content_files_contentId_idx" ON "content_files"("contentId");

-- AddForeignKey
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_files" ADD CONSTRAINT "content_files_contentId_fkey" FOREIGN KEY ("contentId") REFERENCES "content_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

