-- CD-223 แก้ปัญหาทางเทคนิค: a technical project issue records its root cause
-- and fix, and becomes a KBMS draft (sent for review) when resolved.
ALTER TABLE "project_issues" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'general',
ADD COLUMN "cause" TEXT,
ADD COLUMN "kbmsStatus" TEXT,
ADD COLUMN "kbmsRef" TEXT;

CREATE INDEX "project_issues_kbmsStatus_idx" ON "project_issues"("kbmsStatus");
