-- AlterTable
ALTER TABLE "service_material_uses" ADD COLUMN     "erpDocNo" TEXT,
ADD COLUMN     "erpLastError" TEXT,
ADD COLUMN     "erpStatus" TEXT NOT NULL DEFAULT 'none',
ADD COLUMN     "erpSyncedAt" TIMESTAMP(3),
ADD COLUMN     "fromStock" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "warehouseCode" TEXT;

-- CreateTable
CREATE TABLE "service_claims" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "workOrderId" TEXT,
    "requestId" TEXT,
    "assetId" TEXT,
    "productCode" TEXT,
    "description" TEXT NOT NULL,
    "serialNo" TEXT,
    "vendorCode" TEXT NOT NULL,
    "vendorName" TEXT NOT NULL,
    "rmaNo" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "sentOn" DATE,
    "expectedOn" DATE,
    "resolvedOn" DATE,
    "replacementSerial" TEXT,
    "creditAmount" DECIMAL(14,2),
    "outcomeNote" TEXT,
    "overdueNotifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "service_claims_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "service_claims_companyId_status_idx" ON "service_claims"("companyId", "status");

-- CreateIndex
CREATE INDEX "service_claims_workOrderId_idx" ON "service_claims"("workOrderId");

