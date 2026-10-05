-- CreateTable
CREATE TABLE "service_labour_rates" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "workTypeId" TEXT NOT NULL,
    "hourlyRate" DECIMAL(12,2) NOT NULL,
    "productCode" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "service_labour_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_material_uses" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "workOrderId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "productCode" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "unit" TEXT,
    "serialNo" TEXT,
    "billable" BOOLEAN NOT NULL DEFAULT true,
    "unitPrice" DECIMAL(14,2),
    "priceSource" TEXT,
    "unitCost" DECIMAL(14,2),
    "usedOn" DATE NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "service_material_uses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "service_labour_rates_companyId_workTypeId_key" ON "service_labour_rates"("companyId", "workTypeId");

-- CreateIndex
CREATE INDEX "service_material_uses_workOrderId_idx" ON "service_material_uses"("workOrderId");

-- CreateIndex
CREATE INDEX "service_material_uses_companyId_usedOn_idx" ON "service_material_uses"("companyId", "usedOn");

