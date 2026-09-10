-- หน้ารายละเอียด Lead (10 ก.ย. 2569): สถานะระหว่างทาง (ติดต่อไม่ได้ / ติดต่อแล้ว),
-- ข้อมูลบริษัท + ที่อยู่ของ Lead, และตารางกิจกรรม (โทร/อีเมล/นัดหมาย/งาน/บันทึก)

-- AlterEnum — เพิ่มค่าตามลำดับใน pipeline (new → cannot_contact → contacted → qualified)
ALTER TYPE "LeadStatus" ADD VALUE 'cannot_contact' BEFORE 'qualified';
ALTER TYPE "LeadStatus" ADD VALUE 'contacted' BEFORE 'qualified';

-- CreateEnum
CREATE TYPE "LeadActivityType" AS ENUM ('call', 'email', 'meeting', 'task', 'note');

-- AlterTable
ALTER TABLE "leads"
  ADD COLUMN "contactPosition" TEXT,
  ADD COLUMN "nameEn" TEXT,
  ADD COLUMN "taxId" TEXT,
  ADD COLUMN "industry" TEXT,
  ADD COLUMN "companySize" TEXT,
  ADD COLUMN "employeeCount" INTEGER,
  ADD COLUMN "productGroup" TEXT,
  ADD COLUMN "subProduct" TEXT,
  ADD COLUMN "projectRevenue" DECIMAL(14,2),
  ADD COLUMN "addressLine" TEXT,
  ADD COLUMN "district" TEXT,
  ADD COLUMN "province" TEXT,
  ADD COLUMN "postalCode" TEXT,
  ADD COLUMN "country" TEXT NOT NULL DEFAULT 'TH';

-- CreateTable
CREATE TABLE "lead_activities" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "type" "LeadActivityType" NOT NULL,
    "subject" TEXT NOT NULL,
    "detail" TEXT,
    "dueAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "completedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lead_activities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "lead_activities_leadId_dueAt_idx" ON "lead_activities"("leadId", "dueAt");

-- CreateIndex
CREATE INDEX "lead_activities_companyId_createdAt_idx" ON "lead_activities"("companyId", "createdAt");

-- AddForeignKey
ALTER TABLE "lead_activities" ADD CONSTRAINT "lead_activities_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
