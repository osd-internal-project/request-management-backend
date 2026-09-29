-- CreateEnum
CREATE TYPE "SolutionApprovalStatus" AS ENUM ('none', 'pending', 'approved', 'rejected', 'cancelled');

-- AlterTable
ALTER TABLE "crm_company_configs" ADD COLUMN     "solutionApprovalTypeCode" TEXT;

-- AlterTable
ALTER TABLE "solution_versions" ADD COLUMN     "approvalRequestId" TEXT,
ADD COLUMN     "approvalStatus" "SolutionApprovalStatus" NOT NULL DEFAULT 'none',
ADD COLUMN     "approvedAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "solution_versions_approvalRequestId_key" ON "solution_versions"("approvalRequestId");

