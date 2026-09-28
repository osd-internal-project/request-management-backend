-- Flow v2: steps cover the whole lifecycle under status scopes (additive only).
-- AlterTable
ALTER TABLE "requests" ADD COLUMN     "stepHolderUserId" TEXT;

-- AlterTable
ALTER TABLE "request_flow_versions" ADD COLUMN     "schemaVersion" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "request_flow_steps" ADD COLUMN     "approvalLevels" JSONB,
ADD COLUMN     "receiverRule" JSONB,
ADD COLUMN     "requiredDocs" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "returnToStepCode" TEXT,
ADD COLUMN     "scopeStatus" "RequestStatus" NOT NULL DEFAULT 'in_progress';

-- AlterTable
ALTER TABLE "request_step_runs" ADD COLUMN     "heldBy" TEXT;

