-- เลขรันทุกชนิดเอกสารมาอยู่ที่เดียว (22 ก.ย. 2569) — run-number-service เป็นเจ้าของ
-- สองตารางนี้ service อื่นออกเลขผ่าน `POST internal/run-numbers/issue` (§03).
--
-- ที่เก่าของข้อมูลชุดนี้มีหกตาราง: `doc_number_configs`/`doc_number_counters` และ
-- counter ของ CRM สี่ตัว โดยรูปแบบของ OPP/SO/QT ถูก hard-code ไว้ในโค้ด แก้ไม่ได้
-- ถ้าไม่ deploy (ขัด "Configuration over code").
--
-- **ตารางเก่ายังไม่ถูกลบในนี้โดยตั้งใจ** — ลบด้วย migration ตามหลัง เมื่อ production
-- ยืนยันว่าออกเลขจากตารางใหม่แล้ว. การลบพร้อมกันคือตัดทางถอยในรอบที่เสี่ยงที่สุด.
--
-- prefix ของ CRM ถูก backfill เป็น "ตัวอักษรตรง ๆ" ใน pattern ไม่ใช่ token — บริษัทที่
-- แก้ `crm_company_configs."codePrefix"` ไว้ต้องได้รหัสหน้าตาเดิมเป๊ะหลัง deploy.

-- CreateEnum
CREATE TYPE "RunNumberResetPeriod" AS ENUM ('none', 'yearly', 'monthly', 'daily');

-- CreateTable
CREATE TABLE "run_number_settings" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "docType" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL DEFAULT '*',
    "pattern" TEXT NOT NULL,
    "seqPadding" INTEGER NOT NULL DEFAULT 4,
    "startNumber" INTEGER NOT NULL DEFAULT 1,
    "resetPeriod" "RunNumberResetPeriod" NOT NULL DEFAULT 'none',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "run_number_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "run_number_counters" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "docType" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL,
    "lastSeq" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "run_number_counters_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "run_number_settings_companyId_docType_scopeKey_key"
  ON "run_number_settings"("companyId", "docType", "scopeKey");
CREATE INDEX "run_number_settings_companyId_docType_idx"
  ON "run_number_settings"("companyId", "docType");
CREATE UNIQUE INDEX "run_number_counters_companyId_docType_scopeKey_periodKey_key"
  ON "run_number_counters"("companyId", "docType", "scopeKey", "periodKey");

-- AddForeignKey
ALTER TABLE "run_number_settings" ADD CONSTRAINT "run_number_settings_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "run_number_counters" ADD CONSTRAINT "run_number_counters_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
--
-- ไม่มี FK จาก run_number_counters ไป run_number_settings โดยตั้งใจ: ถ้าผูกไว้
-- การลบ setting แล้วสร้างใหม่จะพาลำดับกลับไปเริ่มที่ 1 แล้วออกเลขซ้ำกับเอกสารที่
-- ส่งออกไปแล้ว (NFR-03).

-- ---------------------------------------------------------------------------
-- Backfill 1/5 — REQUEST: หนึ่งแถวต่อ config ที่มีอยู่, รูปแบบเดิมไม่แตะ
-- ---------------------------------------------------------------------------
INSERT INTO "run_number_settings" (
  "id", "companyId", "docType", "scopeKey", "pattern",
  "seqPadding", "startNumber", "resetPeriod", "active", "updatedAt"
)
SELECT
  gen_random_uuid()::text,
  d."companyId",
  'REQUEST',
  d."typeCode",
  d."pattern",
  d."seqPadding",
  1,
  'monthly'::"RunNumberResetPeriod",
  d."active",
  CURRENT_TIMESTAMP
FROM "doc_number_configs" d;

-- แถว `*` ต่อบริษัท — ประเภทคำขอที่ไม่เคยมี config ใช้ค่านี้ แทนที่จะเป็น default
-- ที่ฝังในโค้ดซึ่งหน้าจอมองไม่เห็น
INSERT INTO "run_number_settings" (
  "id", "companyId", "docType", "scopeKey", "pattern",
  "seqPadding", "startNumber", "resetPeriod", "active", "updatedAt"
)
SELECT
  gen_random_uuid()::text,
  c."id",
  'REQUEST',
  '*',
  'REQ-{COMPANY_PREFIX}-{TYPE}-{YYMM}{SEQ}',
  4,
  1,
  'monthly'::"RunNumberResetPeriod",
  true,
  CURRENT_TIMESTAMP
FROM "companies" c
WHERE NOT EXISTS (
  SELECT 1 FROM "run_number_settings" r
  WHERE r."companyId" = c."id" AND r."docType" = 'REQUEST' AND r."scopeKey" = '*'
);

-- ---------------------------------------------------------------------------
-- Backfill 2/5 — CUSTOMER: prefix/padding จาก crm_company_configs ถ้ามี
-- ---------------------------------------------------------------------------
INSERT INTO "run_number_settings" (
  "id", "companyId", "docType", "scopeKey", "pattern",
  "seqPadding", "startNumber", "resetPeriod", "active", "updatedAt"
)
SELECT
  gen_random_uuid()::text,
  c."id",
  'CUSTOMER',
  '*',
  COALESCE(cfg."codePrefix", 'CUS') || '-{COMPANY_PREFIX}-{SEQ}',
  COALESCE(cfg."codePadding", 6),
  1,
  'none'::"RunNumberResetPeriod",
  true,
  CURRENT_TIMESTAMP
FROM "companies" c
LEFT JOIN "crm_company_configs" cfg ON cfg."companyId" = c."id";

-- ---------------------------------------------------------------------------
-- Backfill 3/5 — OPPORTUNITY / SALE_ORDER / QUOTATION: ค่าที่เคย hard-code
-- ---------------------------------------------------------------------------
INSERT INTO "run_number_settings" (
  "id", "companyId", "docType", "scopeKey", "pattern",
  "seqPadding", "startNumber", "resetPeriod", "active", "updatedAt"
)
SELECT
  gen_random_uuid()::text,
  c."id",
  d."docType",
  '*',
  d."pattern",
  d."seqPadding",
  1,
  'none'::"RunNumberResetPeriod",
  true,
  CURRENT_TIMESTAMP
FROM "companies" c
CROSS JOIN (
  VALUES
    ('OPPORTUNITY', 'OPP-{COMPANY_PREFIX}-{SEQ}', 6),
    ('SALE_ORDER',  'SO-{COMPANY_PREFIX}-{SEQ}',  6),
    ('QUOTATION',   'QT-{COMPANY_PREFIX}-{SEQ}',  6)
) AS d("docType", "pattern", "seqPadding");

-- ---------------------------------------------------------------------------
-- Backfill 4/5 — counter ของคำขอ: periodKey คือ yearMonth เดิมเป็น text
-- ---------------------------------------------------------------------------
INSERT INTO "run_number_counters" (
  "id", "companyId", "docType", "scopeKey", "periodKey", "lastSeq", "updatedAt"
)
SELECT
  gen_random_uuid()::text,
  n."companyId",
  'REQUEST',
  n."typeCode",
  n."yearMonth"::text,
  n."lastSeq",
  CURRENT_TIMESTAMP
FROM "doc_number_counters" n;

-- ---------------------------------------------------------------------------
-- Backfill 5/5 — counter ของ CRM ทั้งสี่: ไม่รีเซ็ต จึงเป็น periodKey '-'
--
-- ตกไปตารางเดียวคือบริษัทนั้นเริ่มนับ 1 ใหม่ แล้วออกรหัสซ้ำกับลูกค้า/ใบเสนอราคา
-- ที่ส่งออกไปแล้ว — ยอดก่อน/หลังต้องเทียบกันเสมอหลังรัน migration นี้.
-- ---------------------------------------------------------------------------
INSERT INTO "run_number_counters" (
  "id", "companyId", "docType", "scopeKey", "periodKey", "lastSeq", "updatedAt"
)
SELECT gen_random_uuid()::text, n."companyId", 'CUSTOMER', '*', '-', n."lastSeq", CURRENT_TIMESTAMP
FROM "customer_code_counters" n
UNION ALL
SELECT gen_random_uuid()::text, n."companyId", 'OPPORTUNITY', '*', '-', n."lastSeq", CURRENT_TIMESTAMP
FROM "opportunity_code_counters" n
UNION ALL
SELECT gen_random_uuid()::text, n."companyId", 'SALE_ORDER', '*', '-', n."lastSeq", CURRENT_TIMESTAMP
FROM "sale_order_code_counters" n
UNION ALL
SELECT gen_random_uuid()::text, n."companyId", 'QUOTATION', '*', '-', n."lastSeq", CURRENT_TIMESTAMP
FROM "quotation_code_counters" n;
