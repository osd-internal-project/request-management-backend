-- AlterTable
ALTER TABLE "solution_versions" ADD COLUMN     "deliverables" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "inScope" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "outOfScope" JSONB NOT NULL DEFAULT '[]';

