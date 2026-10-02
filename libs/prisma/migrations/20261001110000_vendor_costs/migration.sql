-- CD-206: suppliers' costs from SAP (synced), the age past which they warn, and the date on a line's cost.
-- AlterTable
ALTER TABLE "crm_company_configs" ADD COLUMN     "costMaxAgeDays" INTEGER NOT NULL DEFAULT 90;

-- AlterTable
ALTER TABLE "quotation_lines" ADD COLUMN     "costDate" DATE;

-- CreateTable
CREATE TABLE "vendor_costs" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "productCode" TEXT NOT NULL,
    "vendorCode" TEXT NOT NULL,
    "vendorName" TEXT,
    "source" TEXT NOT NULL,
    "unitCost" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "docNo" TEXT,
    "costDate" DATE NOT NULL,
    "validTo" DATE,
    "syncedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vendor_costs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "vendor_costs_companyId_productCode_idx" ON "vendor_costs"("companyId", "productCode");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_costs_companyId_productCode_vendorCode_source_key" ON "vendor_costs"("companyId", "productCode", "vendorCode", "source");

