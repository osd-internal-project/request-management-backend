-- AlterTable
ALTER TABLE "crm_company_configs" ADD COLUMN     "serviceRepeatAsset" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "serviceRepeatCustomerModel" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "serviceRepeatDays" INTEGER NOT NULL DEFAULT 90,
ADD COLUMN     "serviceRepeatModel" INTEGER NOT NULL DEFAULT 5;

-- CreateTable
CREATE TABLE "service_problems" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "problemNo" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "assetId" TEXT,
    "productCode" TEXT,
    "customerId" TEXT,
    "ownerUserId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "workaround" TEXT,
    "rootCause" TEXT,
    "permanentFix" TEXT,
    "techChangeRef" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "service_problems_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_problem_links" (
    "id" TEXT NOT NULL,
    "problemId" TEXT NOT NULL,
    "workOrderId" TEXT NOT NULL,
    "linkedBy" TEXT NOT NULL,
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_problem_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_problem_dismissals" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "groupKey" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "dismissedBy" TEXT NOT NULL,
    "dismissedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_problem_dismissals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "service_problems_companyId_status_idx" ON "service_problems"("companyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "service_problems_companyId_problemNo_key" ON "service_problems"("companyId", "problemNo");

-- CreateIndex
CREATE UNIQUE INDEX "service_problem_links_workOrderId_key" ON "service_problem_links"("workOrderId");

-- CreateIndex
CREATE INDEX "service_problem_links_problemId_idx" ON "service_problem_links"("problemId");

-- CreateIndex
CREATE UNIQUE INDEX "service_problem_dismissals_companyId_groupKey_key" ON "service_problem_dismissals"("companyId", "groupKey");

