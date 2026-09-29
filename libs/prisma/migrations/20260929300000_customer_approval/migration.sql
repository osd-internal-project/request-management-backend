-- CreateEnum
CREATE TYPE "CustomerApprovalStatus" AS ENUM ('approved', 'pending', 'rejected');

-- AlterTable
ALTER TABLE "crm_company_configs" ADD COLUMN     "customerApprovalTypes" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "approvalRequestId" TEXT,
ADD COLUMN     "approvalStatus" "CustomerApprovalStatus" NOT NULL DEFAULT 'approved';

