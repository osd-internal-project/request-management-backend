-- CreateTable
CREATE TABLE "service_reports" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "entitlementId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "reportNo" TEXT NOT NULL,
    "periodFrom" DATE NOT NULL,
    "periodTo" DATE NOT NULL,
    "data" JSONB NOT NULL,
    "penaltyAmount" DECIMAL(14,2),
    "penaltyNote" TEXT,
    "pdfKey" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "issuedBy" TEXT NOT NULL,
    "sentOn" DATE,
    "sentTo" TEXT,
    "sentBy" TEXT,

    CONSTRAINT "service_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "service_reports_entitlementId_periodFrom_idx" ON "service_reports"("entitlementId", "periodFrom");

-- CreateIndex
CREATE UNIQUE INDEX "service_reports_companyId_reportNo_key" ON "service_reports"("companyId", "reportNo");

