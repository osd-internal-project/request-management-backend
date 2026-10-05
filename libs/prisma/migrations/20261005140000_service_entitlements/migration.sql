-- CreateTable
CREATE TABLE "service_entitlements" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "contractId" TEXT,
    "projectId" TEXT,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "startOn" DATE NOT NULL,
    "endOn" DATE NOT NULL,
    "coverage" "SlaCoverage",
    "severityTargets" JSONB,
    "correctiveQuota" INTEGER,
    "preventiveQuota" INTEGER,
    "correctiveUsed" INTEGER NOT NULL DEFAULT 0,
    "preventiveUsed" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "source" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelledBy" TEXT,
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "service_entitlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_entitlement_assets" (
    "entitlementId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "addedBy" TEXT NOT NULL,
    "removedAt" TIMESTAMP(3),
    "removedBy" TEXT,

    CONSTRAINT "service_entitlement_assets_pkey" PRIMARY KEY ("entitlementId","assetId")
);

-- CreateIndex
CREATE INDEX "service_entitlements_companyId_customerId_idx" ON "service_entitlements"("companyId", "customerId");

-- CreateIndex
CREATE INDEX "service_entitlements_contractId_idx" ON "service_entitlements"("contractId");

-- CreateIndex
CREATE INDEX "service_entitlement_assets_assetId_idx" ON "service_entitlement_assets"("assetId");

-- AddForeignKey
ALTER TABLE "service_entitlement_assets" ADD CONSTRAINT "service_entitlement_assets_entitlementId_fkey" FOREIGN KEY ("entitlementId") REFERENCES "service_entitlements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_entitlement_assets" ADD CONSTRAINT "service_entitlement_assets_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "service_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

