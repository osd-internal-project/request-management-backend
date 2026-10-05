-- AlterTable
ALTER TABLE "crm_company_configs" ADD COLUMN     "projectCostAlertPct" INTEGER NOT NULL DEFAULT 100,
ADD COLUMN     "projectCostWarnPct" INTEGER NOT NULL DEFAULT 90;

-- CreateTable
CREATE TABLE "project_costs" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "erpKey" TEXT,
    "docNo" TEXT,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "incurredOn" DATE NOT NULL,
    "vendorName" TEXT,
    "evidenceKey" TEXT,
    "evidenceName" TEXT,
    "evidenceMime" TEXT,
    "evidenceSize" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "project_costs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_cost_alerts" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "budgetVersionNo" INTEGER NOT NULL,
    "category" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "budget" DECIMAL(14,2) NOT NULL,
    "actual" DECIMAL(14,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_cost_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_costs_projectId_incurredOn_idx" ON "project_costs"("projectId", "incurredOn");

-- CreateIndex
CREATE UNIQUE INDEX "project_costs_projectId_erpKey_key" ON "project_costs"("projectId", "erpKey");

-- CreateIndex
CREATE UNIQUE INDEX "project_cost_alerts_projectId_budgetVersionNo_category_leve_key" ON "project_cost_alerts"("projectId", "budgetVersionNo", "category", "level");

-- AddForeignKey
ALTER TABLE "project_costs" ADD CONSTRAINT "project_costs_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_cost_alerts" ADD CONSTRAINT "project_cost_alerts_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

