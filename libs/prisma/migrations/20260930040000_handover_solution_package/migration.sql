-- AlterTable
ALTER TABLE "sales_handovers" ADD COLUMN     "solutionVersionId" TEXT;

-- AddForeignKey
ALTER TABLE "sales_handovers" ADD CONSTRAINT "sales_handovers_solutionVersionId_fkey" FOREIGN KEY ("solutionVersionId") REFERENCES "solution_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

