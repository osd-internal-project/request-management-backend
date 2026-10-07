-- CD-283 (CD-23 AI CARE) — a conversation handed to a person: why, when,
-- when the team was last told, and the run of questions AI CARE could not answer.

-- AlterTable
ALTER TABLE "care_conversations" ADD COLUMN     "handoverAt" TIMESTAMP(3),
ADD COLUMN     "handoverNotifiedAt" TIMESTAMP(3),
ADD COLUMN     "handoverReason" TEXT,
ADD COLUMN     "unansweredStreak" INTEGER NOT NULL DEFAULT 0;

