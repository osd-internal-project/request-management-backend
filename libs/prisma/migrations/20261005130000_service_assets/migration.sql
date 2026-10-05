-- CreateTable
CREATE TABLE "service_assets" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "customerId" TEXT,
    "projectId" TEXT,
    "kind" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "installationId" TEXT,
    "environmentId" TEXT,
    "productCode" TEXT,
    "name" TEXT NOT NULL,
    "model" TEXT,
    "serialNo" TEXT,
    "location" TEXT,
    "version" TEXT,
    "installedOn" DATE,
    "acceptedOn" DATE,
    "status" TEXT NOT NULL DEFAULT 'active',
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "service_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_asset_history" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "actorId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_asset_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "service_assets_installationId_key" ON "service_assets"("installationId");

-- CreateIndex
CREATE UNIQUE INDEX "service_assets_environmentId_key" ON "service_assets"("environmentId");

-- CreateIndex
CREATE INDEX "service_assets_companyId_customerId_idx" ON "service_assets"("companyId", "customerId");

-- CreateIndex
CREATE INDEX "service_assets_projectId_idx" ON "service_assets"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "service_assets_companyId_serialNo_key" ON "service_assets"("companyId", "serialNo");

-- CreateIndex
CREATE INDEX "service_asset_history_assetId_at_idx" ON "service_asset_history"("assetId", "at");

-- AddForeignKey
ALTER TABLE "service_asset_history" ADD CONSTRAINT "service_asset_history_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "service_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

