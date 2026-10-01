-- AlterTable
ALTER TABLE "quotation_lines" ADD COLUMN     "costSource" TEXT;

-- AlterTable
ALTER TABLE "quotations" ADD COLUMN     "solutionId" TEXT,
ADD COLUMN     "solutionVersionNo" INTEGER;

