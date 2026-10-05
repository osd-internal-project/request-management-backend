-- CreateTable
CREATE TABLE "service_pm_plans" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "entitlementId" TEXT NOT NULL,
    "interval" TEXT NOT NULL,
    "leadDays" INTEGER NOT NULL DEFAULT 14,
    "ownerUserId" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "service_pm_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_pm_rounds" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "entitlementId" TEXT NOT NULL,
    "roundNo" INTEGER NOT NULL,
    "dueOn" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'planned',
    "workOrderId" TEXT,
    "requestId" TEXT,
    "openedAt" TIMESTAMP(3),
    "openError" TEXT,
    "doneAt" TIMESTAMP(3),
    "skippedReason" TEXT,
    "skippedBy" TEXT,
    "overdueNotifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "service_pm_rounds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_ma_offers" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "entitlementId" TEXT NOT NULL,
    "opportunityId" TEXT,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "remindedDays" INTEGER[] DEFAULT ARRAY[]::INTEGER[],

    CONSTRAINT "service_ma_offers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "service_pm_plans_entitlementId_key" ON "service_pm_plans"("entitlementId");

-- CreateIndex
CREATE INDEX "service_pm_plans_companyId_idx" ON "service_pm_plans"("companyId");

-- CreateIndex
CREATE INDEX "service_pm_rounds_companyId_status_dueOn_idx" ON "service_pm_rounds"("companyId", "status", "dueOn");

-- CreateIndex
CREATE UNIQUE INDEX "service_pm_rounds_entitlementId_roundNo_key" ON "service_pm_rounds"("entitlementId", "roundNo");

-- CreateIndex
CREATE UNIQUE INDEX "service_ma_offers_entitlementId_key" ON "service_ma_offers"("entitlementId");

