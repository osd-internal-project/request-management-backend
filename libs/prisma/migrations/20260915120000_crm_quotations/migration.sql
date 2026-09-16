-- CD-76 ใบเสนอราคา (Quotation): หนึ่งเลขหลายเวอร์ชัน, แก้ได้เฉพาะ draft, ต้นทุนกรอกเอง
-- ต่อบรรทัด, margin ต่ำกว่าเกณฑ์ (ตั้งค่าใน crm_company_configs) ต้องผ่านคำขออนุมัติ
-- ก่อนส่งลูกค้า. ใบสั่งขายอ้างใบเสนอราคาที่ลูกค้ายอมรับได้ (CD-77).

-- CreateEnum
CREATE TYPE "QuotationStatus" AS ENUM ('draft', 'pending_approval', 'approved', 'sent', 'accepted', 'declined', 'superseded', 'cancelled');

-- AlterTable: เกณฑ์และค่าตั้งต้นของใบเสนอราคา
ALTER TABLE "crm_company_configs"
  ADD COLUMN "minMarginPct" DOUBLE PRECISION NOT NULL DEFAULT 15,
  ADD COLUMN "quotationValidityDays" INTEGER NOT NULL DEFAULT 30,
  ADD COLUMN "vatPct" DOUBLE PRECISION NOT NULL DEFAULT 7,
  ADD COLUMN "quotationApprovalTypeCode" TEXT NOT NULL DEFAULT 'DSC';

-- AlterTable: ใบสั่งขายอ้างใบเสนอราคา
ALTER TABLE "sale_orders" ADD COLUMN "quotationId" TEXT;

-- CreateTable
CREATE TABLE "quotations" (
    "id" TEXT NOT NULL,
    "quotationNo" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "companyId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "customerId" TEXT,
    "partyName" TEXT NOT NULL,
    "partyTaxId" TEXT,
    "contactName" TEXT,
    "title" TEXT NOT NULL,
    "status" "QuotationStatus" NOT NULL DEFAULT 'draft',
    "currency" TEXT NOT NULL DEFAULT 'THB',
    "validUntil" TIMESTAMP(3),
    "paymentTerms" TEXT,
    "note" TEXT,
    "subtotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "discountTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "netTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "vatPct" DECIMAL(5,2) NOT NULL DEFAULT 7,
    "vatAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "grandTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "costTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "marginAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "marginPct" DECIMAL(7,2),
    "minMarginPct" DECIMAL(5,2),
    "approvalRequired" BOOLEAN NOT NULL DEFAULT false,
    "approvalRequestId" TEXT,
    "submittedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "respondedAt" TIMESTAMP(3),
    "responseNote" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "ownerUserId" TEXT NOT NULL,
    "ownerOrgUnitId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "quotations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quotation_lines" (
    "id" TEXT NOT NULL,
    "quotationId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "productCode" TEXT,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "unit" TEXT,
    "unitPrice" DECIMAL(14,2) NOT NULL,
    "unitCost" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "discountPct" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "lineTotal" DECIMAL(14,2) NOT NULL,
    "lineCost" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "quotation_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quotation_code_counters" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "lastSeq" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quotation_code_counters_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "quotations_quotationNo_version_key" ON "quotations"("quotationNo", "version");
CREATE INDEX "quotations_companyId_opportunityId_idx" ON "quotations"("companyId", "opportunityId");
CREATE INDEX "quotations_companyId_status_idx" ON "quotations"("companyId", "status");
CREATE INDEX "quotations_companyId_ownerUserId_idx" ON "quotations"("companyId", "ownerUserId");
CREATE INDEX "quotations_companyId_ownerOrgUnitId_idx" ON "quotations"("companyId", "ownerOrgUnitId");
CREATE INDEX "quotations_approvalRequestId_idx" ON "quotations"("approvalRequestId");
CREATE UNIQUE INDEX "quotation_lines_quotationId_lineNo_key" ON "quotation_lines"("quotationId", "lineNo");
CREATE UNIQUE INDEX "quotation_code_counters_companyId_key" ON "quotation_code_counters"("companyId");
CREATE INDEX "sale_orders_quotationId_idx" ON "sale_orders"("quotationId");

-- AddForeignKey
ALTER TABLE "sale_orders" ADD CONSTRAINT "sale_orders_quotationId_fkey" FOREIGN KEY ("quotationId") REFERENCES "quotations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "opportunities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "quotation_lines" ADD CONSTRAINT "quotation_lines_quotationId_fkey" FOREIGN KEY ("quotationId") REFERENCES "quotations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "quotation_code_counters" ADD CONSTRAINT "quotation_code_counters_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- SCOPE-04: ต้นทุนและ margin ของใบเสนอราคาเป็นข้อมูลอ่อนไหว. ค่าตั้งต้น = คนที่ทำใบเสนอราคาได้
-- (`crm.sales.manage`) เห็น, ผู้ที่อ่านอย่างเดียวไม่เห็น — ผู้ดูแลเปลี่ยนสิทธิ์ได้จากหน้าจอ
-- โดยไม่ต้อง deploy. ON CONFLICT: ไม่ทับค่าที่ผู้ดูแลแก้ไว้แล้ว.
INSERT INTO "sensitive_field_rules" ("id", "resource", "field", "visibleToPermission", "createdAt", "updatedAt")
VALUES
  (gen_random_uuid(), 'quotation', 'unitCost', 'crm.sales.manage', NOW(), NOW()),
  (gen_random_uuid(), 'quotation', 'lineCost', 'crm.sales.manage', NOW(), NOW()),
  (gen_random_uuid(), 'quotation', 'costTotal', 'crm.sales.manage', NOW(), NOW()),
  (gen_random_uuid(), 'quotation', 'marginAmount', 'crm.sales.manage', NOW(), NOW()),
  (gen_random_uuid(), 'quotation', 'marginPct', 'crm.sales.manage', NOW(), NOW())
ON CONFLICT ("resource", "field") DO NOTHING;
