-- CD-85 แกน Getter — บริษัทเป้าหมาย, ผลการติดต่อ/ช่องทางเข้าหา, Discovery บน Lead

-- CreateEnum
CREATE TYPE "ActivityOutcome" AS ENUM ('reached', 'no_answer', 'interested', 'not_interested');

-- CreateEnum
CREATE TYPE "TargetAccountPriority" AS ENUM ('high', 'medium', 'low');

-- CreateEnum
CREATE TYPE "TargetAccountStatus" AS ENUM ('targeting', 'approaching', 'converted', 'dropped');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "LeadActivityType" ADD VALUE 'visit';
ALTER TYPE "LeadActivityType" ADD VALUE 'line';
ALTER TYPE "LeadActivityType" ADD VALUE 'social';

-- AlterTable
ALTER TABLE "crm_company_configs" ADD COLUMN     "discoveryRequired" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "lead_activities" ADD COLUMN     "outcome" "ActivityOutcome";

-- AlterTable
ALTER TABLE "leads" ADD COLUMN     "discoveryBudget" DECIMAL(14,2),
ADD COLUMN     "discoveryBudgetNote" TEXT,
ADD COLUMN     "discoveryDecisionMaker" TEXT,
ADD COLUMN     "discoveryNeed" TEXT,
ADD COLUMN     "discoveryTimeframe" DATE;

-- CreateTable
CREATE TABLE "target_accounts" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameEn" TEXT,
    "taxId" TEXT,
    "industry" TEXT,
    "companySize" TEXT,
    "province" TEXT,
    "website" TEXT,
    "note" TEXT,
    "priority" "TargetAccountPriority" NOT NULL DEFAULT 'medium',
    "status" "TargetAccountStatus" NOT NULL DEFAULT 'targeting',
    "dropReason" TEXT,
    "ownerUserId" TEXT,
    "ownerOrgUnitId" TEXT,
    "leadId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "target_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "target_accounts_leadId_key" ON "target_accounts"("leadId");

-- CreateIndex
CREATE INDEX "target_accounts_companyId_status_priority_idx" ON "target_accounts"("companyId", "status", "priority");

-- CreateIndex
CREATE INDEX "target_accounts_companyId_ownerUserId_idx" ON "target_accounts"("companyId", "ownerUserId");

-- AddForeignKey
ALTER TABLE "target_accounts" ADD CONSTRAINT "target_accounts_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "target_accounts" ADD CONSTRAINT "target_accounts_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

