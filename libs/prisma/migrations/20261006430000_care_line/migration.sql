-- CD-285 (CD-23 AI CARE) — files customers send on LINE, still to be copied
-- into our storage (LINE keeps them only for a while).

-- AlterTable
ALTER TABLE "care_messages" ADD COLUMN     "attachmentsPending" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "care_messages_attachmentsPending_idx" ON "care_messages"("attachmentsPending");

