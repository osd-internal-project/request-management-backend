-- PO 10 ก.ย. 2569: การเปิดโอกาสการขายยังไม่ถือเป็นลูกค้า — ลูกค้าในทะเบียนเกิดเมื่อ
-- เปิดใบสั่งขาย (Sale Order) เท่านั้น. โอกาสการขายจึงถือข้อมูลผู้มุ่งหวัง (prospect)
-- แทนลูกค้าได้ และมีตารางใบสั่งขาย (CD-77 โครงระยะ 1) เป็นจุดสร้างลูกค้า.

-- CreateEnum
CREATE TYPE "SaleOrderStatus" AS ENUM ('open', 'cancelled');

-- AlterTable: customer optional + prospect snapshot
ALTER TABLE "opportunities"
  ALTER COLUMN "customerId" DROP NOT NULL,
  ADD COLUMN "prospectName" TEXT,
  ADD COLUMN "prospectTaxId" TEXT,
  ADD COLUMN "prospectContactName" TEXT,
  ADD COLUMN "prospectPhone" TEXT,
  ADD COLUMN "prospectEmail" TEXT;

-- optional relation → Prisma's default referential action becomes SET NULL
ALTER TABLE "opportunities" DROP CONSTRAINT "opportunities_customerId_fkey";
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ต้องระบุลูกค้าเดิม หรือชื่อผู้มุ่งหวัง อย่างใดอย่างหนึ่งเสมอ
ALTER TABLE "opportunities"
  ADD CONSTRAINT "opportunities_customer_or_prospect_check"
  CHECK ("customerId" IS NOT NULL OR "prospectName" IS NOT NULL);

-- CreateTable
CREATE TABLE "sale_orders" (
    "id" TEXT NOT NULL,
    "saleOrderCode" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "status" "SaleOrderStatus" NOT NULL DEFAULT 'open',
    "amount" DECIMAL(14,2),
    "currency" TEXT NOT NULL DEFAULT 'THB',
    "note" TEXT,
    "orderedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "ownerUserId" TEXT NOT NULL,
    "ownerOrgUnitId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "sale_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sale_order_code_counters" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "lastSeq" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sale_order_code_counters_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sale_orders_saleOrderCode_key" ON "sale_orders"("saleOrderCode");
CREATE INDEX "sale_orders_companyId_opportunityId_idx" ON "sale_orders"("companyId", "opportunityId");
CREATE INDEX "sale_orders_companyId_customerId_idx" ON "sale_orders"("companyId", "customerId");
CREATE INDEX "sale_orders_companyId_status_idx" ON "sale_orders"("companyId", "status");
CREATE INDEX "sale_orders_companyId_ownerUserId_idx" ON "sale_orders"("companyId", "ownerUserId");
CREATE INDEX "sale_orders_companyId_ownerOrgUnitId_idx" ON "sale_orders"("companyId", "ownerOrgUnitId");
CREATE UNIQUE INDEX "sale_order_code_counters_companyId_key" ON "sale_order_code_counters"("companyId");

-- AddForeignKey
ALTER TABLE "sale_orders" ADD CONSTRAINT "sale_orders_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sale_orders" ADD CONSTRAINT "sale_orders_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "opportunities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sale_orders" ADD CONSTRAINT "sale_orders_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sale_order_code_counters" ADD CONSTRAINT "sale_order_code_counters_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
