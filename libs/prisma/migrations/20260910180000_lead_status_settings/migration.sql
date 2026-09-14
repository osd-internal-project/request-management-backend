-- สถานะ Lead ตั้งค่าเองได้ (10 ก.ย. 2569) — ย้ายรายการสถานะจาก enum ในโค้ด มาเป็น
-- ตารางต่อบริษัทที่หน้า "ตั้งค่า CRM → สถานะ Lead" เพิ่ม/ลบ/เรียงลำดับได้ (D-09).
--
-- เก็บเฉพาะ "รายการขั้น" — กฎการเลื่อนขั้นอยู่บน service workflowable ไม่ใช่ที่นี่
-- (PO 10 ก.ย. 2569: "Workflow owns Process, Core owns Data").
--
-- ค่าเดิมทั้งหกถูก seed ให้ทุกบริษัท โดยรหัสเท่าเดิม — `leads.status` จึงชี้ของเดิม
-- ได้ทันทีหลังเปลี่ยนชนิดคอลัมน์เป็น text ไม่มีแถวไหนต้องแก้ค่า.

-- CreateEnum
CREATE TYPE "LeadStatusKind" AS ENUM ('open', 'won', 'lost');

-- CreateTable
CREATE TABLE "lead_statuses" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "nameTh" TEXT NOT NULL,
    "kind" "LeadStatusKind" NOT NULL DEFAULT 'open',
    "color" TEXT NOT NULL DEFAULT 'default',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "lead_statuses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "lead_statuses_companyId_code_key" ON "lead_statuses"("companyId", "code");
CREATE INDEX "lead_statuses_companyId_sortOrder_idx" ON "lead_statuses"("companyId", "sortOrder");

-- AddForeignKey
ALTER TABLE "lead_statuses" ADD CONSTRAINT "lead_statuses_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Seed — ชุดเดิมทั้งหก ให้ทุกบริษัทที่มีอยู่
INSERT INTO "lead_statuses" (
  "id", "companyId", "code", "nameTh", "kind", "color",
  "isDefault", "isSystem", "sortOrder", "updatedAt"
)
SELECT
  gen_random_uuid()::text,
  c."id",
  d."code",
  d."nameTh",
  d."kind"::"LeadStatusKind",
  d."color",
  d."isDefault",
  d."isSystem",
  d."sortOrder",
  CURRENT_TIMESTAMP
FROM "companies" c
CROSS JOIN (
  VALUES
    ('new',            'ใหม่',                        'open', 'blue',   true,  true,  10),
    ('cannot_contact', 'ติดต่อไม่ได้',                 'open', 'orange', false, false, 20),
    ('contacted',      'ติดต่อแล้ว',                   'open', 'cyan',   false, false, 30),
    ('qualified',      'ผ่านคัดกรอง',                  'open', 'green',  false, false, 40),
    ('converted',      'แปลงเป็นโอกาสการขายแล้ว',        'won',  'purple', false, true,  50),
    ('disqualified',   'คัดออก',                       'lost', 'red',    false, true,  60)
) AS d("code", "nameTh", "kind", "color", "isDefault", "isSystem", "sortOrder");

-- AlterTable — leads.status: enum → text (ค่าเดิมคงเดิมทุกแถว)
ALTER TABLE "leads" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "leads" ALTER COLUMN "status" TYPE TEXT USING "status"::TEXT;
ALTER TABLE "leads" ALTER COLUMN "status" SET DEFAULT 'new';

-- DropEnum — ไม่มีคอลัมน์ไหนใช้ "LeadStatus" อีกแล้ว
DROP TYPE "LeadStatus";
