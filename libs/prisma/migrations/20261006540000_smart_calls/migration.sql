-- AlterTable
ALTER TABLE "smart_prospects" ADD COLUMN     "interestedAt" TIMESTAMP(3),
ADD COLUMN     "lastCallId" TEXT;

-- CreateTable
CREATE TABLE "smart_calls" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "listId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "prospectId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "externalCallId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'dialling',
    "outcome" TEXT,
    "durationSec" INTEGER,
    "transcript" TEXT,
    "recordingRef" TEXT,
    "summary" TEXT,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "smart_calls_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "smart_calls_externalCallId_key" ON "smart_calls"("externalCallId");

-- CreateIndex
CREATE INDEX "smart_calls_companyId_listId_startedAt_idx" ON "smart_calls"("companyId", "listId", "startedAt");

-- CreateIndex
CREATE INDEX "smart_calls_companyId_status_idx" ON "smart_calls"("companyId", "status");

