-- CD-86 แกน Keeper — แผนบัญชี, การติดต่อ/ทบทวน, ชนิดของโอกาสการขาย

-- CreateEnum
CREATE TYPE "AccountTier" AS ENUM ('a', 'b', 'c');

-- CreateEnum
CREATE TYPE "OpportunityDealType" AS ENUM ('new_business', 'upsell', 'cross_sell', 'renewal');

-- CreateEnum
CREATE TYPE "CustomerTouchType" AS ENUM ('review', 'call', 'email', 'meeting', 'visit', 'line', 'social');

-- AlterTable
ALTER TABLE "crm_company_configs" ADD COLUMN     "healthNoContactDays" INTEGER NOT NULL DEFAULT 60;

-- AlterTable
ALTER TABLE "opportunities" ADD COLUMN     "dealType" "OpportunityDealType" NOT NULL DEFAULT 'new_business';

-- CreateTable
CREATE TABLE "customer_account_plans" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "tier" "AccountTier" NOT NULL DEFAULT 'b',
    "goals" TEXT,
    "targetRevenue" DECIMAL(14,2),
    "reviewEveryMonths" INTEGER NOT NULL DEFAULT 3,
    "nextReviewOn" DATE,
    "reviewRemindedOn" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "customer_account_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_touchpoints" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "type" "CustomerTouchType" NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "summary" TEXT NOT NULL,
    "satisfaction" INTEGER,
    "nextSteps" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "customer_touchpoints_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "customer_account_plans_customerId_key" ON "customer_account_plans"("customerId");

-- CreateIndex
CREATE INDEX "customer_account_plans_companyId_nextReviewOn_idx" ON "customer_account_plans"("companyId", "nextReviewOn");

-- CreateIndex
CREATE INDEX "customer_touchpoints_customerId_occurredAt_idx" ON "customer_touchpoints"("customerId", "occurredAt");

-- CreateIndex
CREATE INDEX "customer_touchpoints_companyId_occurredAt_idx" ON "customer_touchpoints"("companyId", "occurredAt");

-- AddForeignKey
ALTER TABLE "customer_account_plans" ADD CONSTRAINT "customer_account_plans_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_touchpoints" ADD CONSTRAINT "customer_touchpoints_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ดีลต่ออายุที่ CD-70 เปิดไว้แล้ว = renewal
UPDATE "opportunities" SET "dealType" = 'renewal' WHERE "id" IN (SELECT "renewalOpportunityId" FROM "customer_contracts" WHERE "renewalOpportunityId" IS NOT NULL);
