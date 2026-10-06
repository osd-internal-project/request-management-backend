-- CD-264 (CD-22 KBMS) — the field-knowledge inbox takes more than service
-- jobs: a Solution's answered technical question (Pre-Sales, CD-140) too.
-- Each candidate names its source row in `sourceId`; work-order fields
-- become optional.

DROP INDEX "kb_candidates_source_workOrderId_key";

ALTER TABLE "kb_candidates" ADD COLUMN "solutionId" TEXT,
ADD COLUMN "sourceId" TEXT,
ALTER COLUMN "workOrderId" DROP NOT NULL,
ALTER COLUMN "requestId" DROP NOT NULL;

-- Existing candidates are service jobs: their source row is the work order.
UPDATE "kb_candidates" SET "sourceId" = "workOrderId" WHERE "sourceId" IS NULL;
ALTER TABLE "kb_candidates" ALTER COLUMN "sourceId" SET NOT NULL;

CREATE INDEX "kb_candidates_workOrderId_idx" ON "kb_candidates"("workOrderId");
CREATE UNIQUE INDEX "kb_candidates_source_sourceId_key" ON "kb_candidates"("source", "sourceId");
