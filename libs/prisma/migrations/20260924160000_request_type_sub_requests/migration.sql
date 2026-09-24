-- Per-type checklist of sub requests the receiver raises under a request.
-- AlterTable
ALTER TABLE "request_types" ADD COLUMN "subRequestTypes" JSONB NOT NULL DEFAULT '[]';
