-- AlterTable
ALTER TABLE "smart_prospects" ADD COLUMN     "aiSummary" TEXT,
ADD COLUMN     "leadId" TEXT,
ADD COLUMN     "matchCustomerId" TEXT,
ADD COLUMN     "matchKind" TEXT,
ADD COLUMN     "matchLeadId" TEXT,
ADD COLUMN     "score" INTEGER,
ADD COLUMN     "scoreReasons" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "screenedAt" TIMESTAMP(3),
ADD COLUMN     "sentAt" TIMESTAMP(3),
ADD COLUMN     "sentBy" TEXT,
ADD COLUMN     "sentOutcome" TEXT;

-- CreateIndex
CREATE INDEX "smart_prospects_companyId_status_score_idx" ON "smart_prospects"("companyId", "status", "score");

