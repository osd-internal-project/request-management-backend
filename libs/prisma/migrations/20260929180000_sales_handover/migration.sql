-- CreateEnum
CREATE TYPE "HandoverItemCategory" AS ENUM ('commercial', 'requirement', 'commitment');

-- CreateEnum
CREATE TYPE "SalesHandoverStatus" AS ENUM ('draft', 'submitted', 'accepted', 'returned');

-- AlterTable
ALTER TABLE "crm_company_configs" ADD COLUMN     "handoverOrgUnitId" TEXT;

-- CreateTable
CREATE TABLE "handover_checklist_items" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "category" "HandoverItemCategory" NOT NULL,
    "label" TEXT NOT NULL,
    "requiresDetail" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "handover_checklist_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_handovers" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "status" "SalesHandoverStatus" NOT NULL DEFAULT 'draft',
    "toOrgUnitId" TEXT,
    "items" JSONB NOT NULL DEFAULT '[]',
    "note" TEXT,
    "round" INTEGER NOT NULL DEFAULT 0,
    "submittedBy" TEXT,
    "submittedAt" TIMESTAMP(3),
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "returnReason" TEXT,
    "history" JSONB NOT NULL DEFAULT '[]',
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "sales_handovers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "handover_checklist_items_companyId_code_key" ON "handover_checklist_items"("companyId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "sales_handovers_opportunityId_key" ON "sales_handovers"("opportunityId");

-- CreateIndex
CREATE INDEX "sales_handovers_companyId_toOrgUnitId_status_idx" ON "sales_handovers"("companyId", "toOrgUnitId", "status");

-- AddForeignKey
ALTER TABLE "handover_checklist_items" ADD CONSTRAINT "handover_checklist_items_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_handovers" ADD CONSTRAINT "sales_handovers_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "opportunities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

