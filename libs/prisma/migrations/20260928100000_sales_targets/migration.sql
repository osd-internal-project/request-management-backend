-- CD-82 เป้าและพยากรณ์ — เป้ายอดขายรายเดือนต่อพนักงาน/กลุ่ม + ประวัติการเปลี่ยน
-- (การปรับงวดที่เริ่มแล้วผ่านคำขออนุมัติ ประเภทตั้งที่ crm_company_configs).

-- CreateEnum
CREATE TYPE "SalesTargetScope" AS ENUM ('user', 'org_unit');

-- CreateEnum
CREATE TYPE "SalesTargetRevisionStatus" AS ENUM ('applied', 'pending_approval', 'rejected', 'cancelled');

-- AlterTable
ALTER TABLE "crm_company_configs" ADD COLUMN "targetApprovalTypeCode" TEXT;

-- CreateTable
CREATE TABLE "sales_targets" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "scope" "SalesTargetScope" NOT NULL,
    "subjectId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "sales_targets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_target_revisions" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "previousAmount" DECIMAL(14,2),
    "newAmount" DECIMAL(14,2) NOT NULL,
    "reason" TEXT,
    "status" "SalesTargetRevisionStatus" NOT NULL,
    "approvalRequestId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "sales_target_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sales_targets_companyId_scope_subjectId_period_key" ON "sales_targets"("companyId", "scope", "subjectId", "period");

-- CreateIndex
CREATE INDEX "sales_targets_companyId_period_idx" ON "sales_targets"("companyId", "period");

-- CreateIndex
CREATE UNIQUE INDEX "sales_target_revisions_approvalRequestId_key" ON "sales_target_revisions"("approvalRequestId");

-- CreateIndex
CREATE INDEX "sales_target_revisions_targetId_createdAt_idx" ON "sales_target_revisions"("targetId", "createdAt");

-- AddForeignKey
ALTER TABLE "sales_targets" ADD CONSTRAINT "sales_targets_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_target_revisions" ADD CONSTRAINT "sales_target_revisions_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "sales_targets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ไม่เกินหนึ่งการปรับที่รออนุมัติต่อเป้า — กันยื่นซ้อนจากสองหน้าต่างพร้อมกัน.
CREATE UNIQUE INDEX "sales_target_revisions_one_pending_per_target" ON "sales_target_revisions"("targetId") WHERE "status" = 'pending_approval';
