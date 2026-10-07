-- CD-273 (CD-15 MACOM) — brand library: assets, approved versions, the current one.
-- AlterTable
ALTER TABLE "crm_company_configs" ADD COLUMN     "brandApprovalTypeCode" TEXT;

-- CreateTable
CREATE TABLE "brand_assets" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "currentVersionId" TEXT,
    "retiredAt" TIMESTAMP(3),
    "retiredBy" TEXT,
    "retireReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "brand_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brand_asset_versions" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "versionNo" INTEGER NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "approvalRequestId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "uploadedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "brand_asset_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "brand_assets_companyId_category_idx" ON "brand_assets"("companyId", "category");

-- CreateIndex
CREATE INDEX "brand_asset_versions_approvalRequestId_idx" ON "brand_asset_versions"("approvalRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "brand_asset_versions_assetId_versionNo_key" ON "brand_asset_versions"("assetId", "versionNo");

-- AddForeignKey
ALTER TABLE "brand_asset_versions" ADD CONSTRAINT "brand_asset_versions_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "brand_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

