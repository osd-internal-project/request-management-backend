-- CreateTable
CREATE TABLE "hr_manday_alerts" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "budgetVersionNo" INTEGER NOT NULL DEFAULT 0,
    "threshold" INTEGER NOT NULL,
    "plannedMandays" DECIMAL(10,2) NOT NULL,
    "actualMandays" DECIMAL(10,2) NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hr_manday_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "hr_manday_alerts_companyId_idx" ON "hr_manday_alerts"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "hr_manday_alerts_projectId_budgetVersionNo_threshold_key" ON "hr_manday_alerts"("projectId", "budgetVersionNo", "threshold");

