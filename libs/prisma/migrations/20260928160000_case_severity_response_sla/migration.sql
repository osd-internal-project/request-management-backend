-- CD-67 เคสและข้อร้องเรียน — บนระบบคำขอเดิม: ระดับความรุนแรงบนคำขอ, เป้าเวลาตามระดับ
-- ต่อประเภทคำขอ (SlaConfig), และนาฬิกาเวลาตอบกลับแยกจากเวลาแก้ไข (SlaClock).

-- CreateEnum
CREATE TYPE "RequestSeverity" AS ENUM ('critical', 'high', 'medium', 'low');

-- AlterTable
ALTER TABLE "requests" ADD COLUMN "severity" "RequestSeverity";

-- AlterTable
ALTER TABLE "sla_configs" ADD COLUMN "severityTargets" JSONB;

-- AlterTable
ALTER TABLE "sla_clocks" ADD COLUMN "responseDueAt" TIMESTAMP(3),
ADD COLUMN "respondedAt" TIMESTAMP(3),
ADD COLUMN "responseBreachedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "sla_clocks_respondedAt_responseDueAt_idx" ON "sla_clocks"("respondedAt", "responseDueAt");
