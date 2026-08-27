-- CD-92 v2 (27 Aug 2026): dashboards move from env constants to configuration
-- rows, each optionally scoped to org units. No audience rows = the whole
-- company sees it; an assigned unit covers its subtree via org_closure.

-- CreateTable
CREATE TABLE "bi_dashboards" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "metabaseDashboardId" INTEGER NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "bi_dashboards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bi_dashboard_audiences" (
    "dashboardId" TEXT NOT NULL,
    "orgUnitId" TEXT NOT NULL,

    CONSTRAINT "bi_dashboard_audiences_pkey" PRIMARY KEY ("dashboardId","orgUnitId")
);

-- CreateIndex
CREATE INDEX "bi_dashboards_companyId_idx" ON "bi_dashboards"("companyId");

-- CreateIndex
CREATE INDEX "bi_dashboard_audiences_orgUnitId_idx" ON "bi_dashboard_audiences"("orgUnitId");

-- AddForeignKey
ALTER TABLE "bi_dashboards" ADD CONSTRAINT "bi_dashboards_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bi_dashboard_audiences" ADD CONSTRAINT "bi_dashboard_audiences_dashboardId_fkey" FOREIGN KEY ("dashboardId") REFERENCES "bi_dashboards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bi_dashboard_audiences" ADD CONSTRAINT "bi_dashboard_audiences_orgUnitId_fkey" FOREIGN KEY ("orgUnitId") REFERENCES "org_units"("id") ON DELETE CASCADE ON UPDATE CASCADE;
