-- AlterTable
ALTER TABLE "crm_company_configs" ADD COLUMN     "serviceWorkOrderTypeCode" TEXT;

-- CreateTable
CREATE TABLE "service_work_orders" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "customerId" TEXT,
    "assetId" TEXT,
    "workKind" TEXT NOT NULL,
    "suggestedBilling" TEXT NOT NULL,
    "suggestedEntitlementId" TEXT,
    "suggestionNote" TEXT,
    "billing" TEXT,
    "entitlementId" TEXT,
    "billingReason" TEXT,
    "confirmedBy" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "quotaTaken" TEXT,
    "ackName" TEXT,
    "ackOn" DATE,
    "ackEstimate" DECIMAL(14,2),
    "ackBy" TEXT,
    "cause" TEXT,
    "resolution" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "service_work_orders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "service_work_orders_requestId_key" ON "service_work_orders"("requestId");

-- CreateIndex
CREATE INDEX "service_work_orders_companyId_customerId_idx" ON "service_work_orders"("companyId", "customerId");

-- CreateIndex
CREATE INDEX "service_work_orders_assetId_idx" ON "service_work_orders"("assetId");

