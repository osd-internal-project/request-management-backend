-- Approval level options, per-candidate votes and SLA escalation tiers (additive only).
-- AlterTable
ALTER TABLE "approval_steps" ADD COLUMN     "escalationLevel" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "mode" TEXT NOT NULL DEFAULT 'any',
ADD COLUMN     "noteRequired" TEXT NOT NULL DEFAULT 'always',
ADD COLUMN     "skipReason" TEXT,
ADD COLUMN     "slaHours" INTEGER;

-- AlterTable
ALTER TABLE "sla_configs" ADD COLUMN     "escalatePercents" INTEGER[] DEFAULT ARRAY[100, 150]::INTEGER[];

-- AlterTable
ALTER TABLE "sla_clocks" ADD COLUMN     "escalationLevel" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "approval_votes" (
    "id" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "decidedBy" TEXT NOT NULL,
    "delegationId" TEXT,
    "decision" "ApprovalDecision" NOT NULL,
    "note" TEXT,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_votes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "approval_votes_stepId_userId_key" ON "approval_votes"("stepId", "userId");

-- AddForeignKey
ALTER TABLE "approval_votes" ADD CONSTRAINT "approval_votes_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "approval_steps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

