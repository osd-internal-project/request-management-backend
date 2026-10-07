-- CD-272 (CD-15 MACOM) — content approval on the approval engine, bound to the content version.
-- AlterTable
ALTER TABLE "content_items" ADD COLUMN     "approvalNote" TEXT,
ADD COLUMN     "approvalRequestId" TEXT,
ADD COLUMN     "approvalStatus" TEXT NOT NULL DEFAULT 'none',
ADD COLUMN     "approvedVersion" INTEGER,
ADD COLUMN     "mentionsCustomer" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "mentionsPartner" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "mentionsPrice" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "crm_company_configs" ADD COLUMN     "contentApprovalAll" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "contentApprovalTypeCode" TEXT;

