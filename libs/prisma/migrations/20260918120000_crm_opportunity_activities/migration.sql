-- CD-65 กิจกรรมและการติดตาม: กิจกรรมบนโอกาสการขาย + วันติดตามครั้งถัดไป + แจ้งหัวหน้า
-- เมื่อดีลเงียบเกินจำนวนวันที่ตั้งค่าไว้ (crm_company_configs.staleOpportunityDays).

-- AlterTable: เกณฑ์ดีลเงียบ
ALTER TABLE "crm_company_configs" ADD COLUMN "staleOpportunityDays" INTEGER NOT NULL DEFAULT 14;

-- AlterTable: สรุปการติดตามบนแถวโอกาสการขาย
ALTER TABLE "opportunities"
  ADD COLUMN "lastActivityAt" TIMESTAMP(3),
  ADD COLUMN "nextFollowUpAt" TIMESTAMP(3),
  ADD COLUMN "staleAlertedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "opportunity_activities" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "type" "LeadActivityType" NOT NULL,
    "subject" TEXT NOT NULL,
    "detail" TEXT,
    "dueAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "completedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "opportunity_activities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "opportunity_activities_opportunityId_dueAt_idx" ON "opportunity_activities"("opportunityId", "dueAt");

-- CreateIndex
CREATE INDEX "opportunity_activities_companyId_createdAt_idx" ON "opportunity_activities"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "opportunities_stage_lastActivityAt_idx" ON "opportunities"("stage", "lastActivityAt");

-- AddForeignKey
ALTER TABLE "opportunity_activities" ADD CONSTRAINT "opportunity_activities_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "opportunities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
