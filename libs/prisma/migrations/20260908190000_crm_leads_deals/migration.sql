-- CreateEnum
CREATE TYPE "LeadStatus" AS ENUM ('new', 'qualified', 'disqualified', 'converted');

-- CreateEnum
CREATE TYPE "DealStage" AS ENUM ('qualifying', 'proposing', 'negotiating', 'won', 'lost');

-- CreateTable
CREATE TABLE "leads" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contactName" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "note" TEXT,
    "sourceCode" TEXT,
    "status" "LeadStatus" NOT NULL DEFAULT 'new',
    "disqualifyReason" TEXT,
    "customerId" TEXT,
    "convertedDealId" TEXT,
    "ownerUserId" TEXT NOT NULL,
    "ownerOrgUnitId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deals" (
    "id" TEXT NOT NULL,
    "dealCode" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "stage" "DealStage" NOT NULL DEFAULT 'qualifying',
    "amount" DECIMAL(14,2),
    "currency" TEXT NOT NULL DEFAULT 'THB',
    "probability" INTEGER,
    "expectedCloseAt" TIMESTAMP(3),
    "wonAt" TIMESTAMP(3),
    "lostAt" TIMESTAMP(3),
    "lostReasonCode" TEXT,
    "lostReasonText" TEXT,
    "ownerUserId" TEXT NOT NULL,
    "ownerOrgUnitId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "deals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deal_products" (
    "id" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "productCode" TEXT NOT NULL,
    "name" TEXT,

    CONSTRAINT "deal_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deal_lost_reasons" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "deal_lost_reasons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deal_code_counters" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "lastSeq" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deal_code_counters_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "leads_convertedDealId_key" ON "leads"("convertedDealId");
CREATE INDEX "leads_companyId_status_idx" ON "leads"("companyId", "status");
CREATE INDEX "leads_companyId_ownerUserId_idx" ON "leads"("companyId", "ownerUserId");
CREATE INDEX "leads_companyId_ownerOrgUnitId_idx" ON "leads"("companyId", "ownerOrgUnitId");
CREATE UNIQUE INDEX "deals_dealCode_key" ON "deals"("dealCode");
CREATE INDEX "deals_companyId_stage_idx" ON "deals"("companyId", "stage");
CREATE INDEX "deals_companyId_customerId_idx" ON "deals"("companyId", "customerId");
CREATE INDEX "deals_companyId_ownerUserId_idx" ON "deals"("companyId", "ownerUserId");
CREATE INDEX "deals_companyId_ownerOrgUnitId_idx" ON "deals"("companyId", "ownerOrgUnitId");
CREATE UNIQUE INDEX "deal_products_dealId_productCode_key" ON "deal_products"("dealId", "productCode");
CREATE UNIQUE INDEX "deal_lost_reasons_companyId_code_key" ON "deal_lost_reasons"("companyId", "code");
CREATE UNIQUE INDEX "deal_code_counters_companyId_key" ON "deal_code_counters"("companyId");

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "leads" ADD CONSTRAINT "leads_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "leads" ADD CONSTRAINT "leads_convertedDealId_fkey" FOREIGN KEY ("convertedDealId") REFERENCES "deals"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "deals" ADD CONSTRAINT "deals_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "deals" ADD CONSTRAINT "deals_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "deal_products" ADD CONSTRAINT "deal_products_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "deals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "deal_lost_reasons" ADD CONSTRAINT "deal_lost_reasons_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "deal_code_counters" ADD CONSTRAINT "deal_code_counters_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
