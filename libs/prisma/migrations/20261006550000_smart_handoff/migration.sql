-- AlterTable
ALTER TABLE "crm_company_configs" ADD COLUMN     "smartGetterOrgUnitId" TEXT,
ADD COLUMN     "smartGovernmentOrgUnitId" TEXT,
ADD COLUMN     "smartHandoffTypeCode" TEXT,
ADD COLUMN     "smartPartnerOrgUnitId" TEXT;

-- AlterTable
ALTER TABLE "smart_prospects" ADD COLUMN     "handedOffAt" TIMESTAMP(3),
ADD COLUMN     "handoffAxis" TEXT,
ADD COLUMN     "handoffError" TEXT,
ADD COLUMN     "handoffRequestId" TEXT;

