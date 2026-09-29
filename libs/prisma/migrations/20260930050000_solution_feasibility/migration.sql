-- CreateEnum
CREATE TYPE "FeasibilityVerdict" AS ENUM ('unassessed', 'feasible', 'conditional', 'not_feasible');

-- AlterTable
ALTER TABLE "solution_versions" ADD COLUMN     "feasibility" "FeasibilityVerdict" NOT NULL DEFAULT 'unassessed',
ADD COLUMN     "feasibilityNote" TEXT NOT NULL DEFAULT '';

