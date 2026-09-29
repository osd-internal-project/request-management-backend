-- CD-53 — กติกาแจ้งเตือนจากเหตุการณ์ รวมไว้ที่เดียว (ต่อบริษัท)

CREATE TABLE "notification_rules" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "params" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,
    CONSTRAINT "notification_rules_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "notification_rules_companyId_code_key" ON "notification_rules"("companyId", "code");
ALTER TABLE "notification_rules" ADD CONSTRAINT "notification_rules_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ดีลเงียบ (CD-65) เคยตั้งในหน้าตั้งค่า CRM — ย้ายค่าที่บริษัทตั้งไว้มาเป็นกติกา
-- (0 = ปิด). คอลัมน์เดิมคงไว้ แต่ไม่มีใครอ่านแล้ว.
INSERT INTO "notification_rules" ("id", "companyId", "code", "enabled", "params", "updatedAt")
SELECT gen_random_uuid()::text, "companyId", 'opportunity.stale',
       "staleOpportunityDays" > 0,
       jsonb_build_object('days', CASE WHEN "staleOpportunityDays" > 0 THEN "staleOpportunityDays" ELSE 14 END),
       CURRENT_TIMESTAMP
FROM "crm_company_configs"
WHERE "staleOpportunityDays" <> 14;

-- เตือนต่ออายุสัญญา: จากคอลัมน์ต่อขั้น (60/30) เป็นรายการขั้นที่ส่งแล้ว
ALTER TABLE "customer_contracts" ADD COLUMN "remindedDays" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[];
UPDATE "customer_contracts" SET "remindedDays" =
    (CASE WHEN "reminded60At" IS NOT NULL THEN ARRAY[60] ELSE ARRAY[]::INTEGER[] END) ||
    (CASE WHEN "reminded30At" IS NOT NULL THEN ARRAY[30] ELSE ARRAY[]::INTEGER[] END);
ALTER TABLE "customer_contracts" DROP COLUMN "reminded60At", DROP COLUMN "reminded30At";

CREATE TABLE "invoice_overdue_alerts" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "docNo" TEXT NOT NULL,
    "step" INTEGER NOT NULL,
    "dueOn" DATE NOT NULL,
    "alertedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "invoice_overdue_alerts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "invoice_overdue_alerts_customerId_docNo_step_key" ON "invoice_overdue_alerts"("customerId", "docNo", "step");
CREATE INDEX "invoice_overdue_alerts_companyId_idx" ON "invoice_overdue_alerts"("companyId");
