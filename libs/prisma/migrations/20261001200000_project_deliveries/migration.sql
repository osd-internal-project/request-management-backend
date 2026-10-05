-- CreateTable
CREATE TABLE "project_deliveries" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "milestoneId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "plannedOn" DATE NOT NULL,
    "location" TEXT NOT NULL,
    "receiverName" TEXT NOT NULL DEFAULT '',
    "receiverPhone" TEXT NOT NULL DEFAULT '',
    "note" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'planned',
    "warnedFor" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "project_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_delivery_lines" (
    "id" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "boqIndex" INTEGER NOT NULL,
    "quantity" DECIMAL(12,2) NOT NULL,
    "readiness" TEXT NOT NULL DEFAULT 'unknown',
    "readyQty" DECIMAL(12,2),
    "expectedOn" DATE,
    "fallbackPlan" TEXT NOT NULL DEFAULT '',
    "note" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "project_delivery_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_deliveries_companyId_status_plannedOn_idx" ON "project_deliveries"("companyId", "status", "plannedOn");

-- CreateIndex
CREATE INDEX "project_deliveries_milestoneId_idx" ON "project_deliveries"("milestoneId");

-- CreateIndex
CREATE UNIQUE INDEX "project_deliveries_projectId_seq_key" ON "project_deliveries"("projectId", "seq");

-- CreateIndex
CREATE INDEX "project_delivery_lines_deliveryId_idx" ON "project_delivery_lines"("deliveryId");

-- AddForeignKey
ALTER TABLE "project_delivery_lines" ADD CONSTRAINT "project_delivery_lines_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "project_deliveries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

