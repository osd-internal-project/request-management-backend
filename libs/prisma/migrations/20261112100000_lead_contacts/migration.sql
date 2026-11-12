-- ผู้ติดต่อเพิ่มเติมของ Lead (12 พ.ย. 2569): ผู้ติดต่อหลักยังอยู่บน leads, ตารางนี้เก็บคนที่สองเป็นต้นไป
CREATE TABLE "lead_contacts" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "lead_contacts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "lead_contacts_leadId_active_idx" ON "lead_contacts"("leadId", "active");
CREATE INDEX "lead_contacts_companyId_idx" ON "lead_contacts"("companyId");

ALTER TABLE "lead_contacts" ADD CONSTRAINT "lead_contacts_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
