-- CD-282 (CD-23 AI CARE) — a service case opened from a conversation: the
-- offer AI CARE made when it could not answer, and the case it became.
ALTER TABLE "care_conversations" ADD COLUMN     "caseOfferedAt" TIMESTAMP(3),
ADD COLUMN     "caseOpenedAt" TIMESTAMP(3),
ADD COLUMN     "caseRequestId" TEXT;
