-- CreateTable
CREATE TABLE "presales_partners" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "vendorCode" TEXT NOT NULL,
    "vendorNameSeen" TEXT NOT NULL DEFAULT '',
    "summary" TEXT NOT NULL DEFAULT '',
    "brands" JSONB NOT NULL DEFAULT '[]',
    "certifications" JSONB NOT NULL DEFAULT '[]',
    "contacts" JSONB NOT NULL DEFAULT '[]',
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "presales_partners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "presales_partner_files" (
    "id" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'other',
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "uploadedBy" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "presales_partner_files_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "presales_partners_companyId_vendorCode_key" ON "presales_partners"("companyId", "vendorCode");

-- CreateIndex
CREATE INDEX "presales_partner_files_partnerId_idx" ON "presales_partner_files"("partnerId");

-- AddForeignKey
ALTER TABLE "presales_partner_files" ADD CONSTRAINT "presales_partner_files_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "presales_partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

