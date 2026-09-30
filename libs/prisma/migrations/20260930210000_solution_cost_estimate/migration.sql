-- AlterTable
ALTER TABLE "crm_company_configs" ADD COLUMN     "presalesLaborRates" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "vendorQuoteTypeCode" TEXT;

-- AlterTable
ALTER TABLE "solution_versions" ADD COLUMN     "labor" JSONB NOT NULL DEFAULT '[]';

-- CreateTable
CREATE TABLE "solution_partner_quotes" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "solutionId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "vendorName" TEXT NOT NULL,
    "vendorCode" TEXT NOT NULL DEFAULT '',
    "quoteNo" TEXT NOT NULL DEFAULT '',
    "quoteDate" DATE,
    "validUntil" DATE,
    "requestId" TEXT,
    "lines" JSONB NOT NULL DEFAULT '[]',
    "fileName" TEXT,
    "mimeType" TEXT,
    "sizeBytes" INTEGER,
    "storageKey" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "solution_partner_quotes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "solution_partner_quotes_versionId_idx" ON "solution_partner_quotes"("versionId");

-- AddForeignKey
ALTER TABLE "solution_partner_quotes" ADD CONSTRAINT "solution_partner_quotes_solutionId_fkey" FOREIGN KEY ("solutionId") REFERENCES "solutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

