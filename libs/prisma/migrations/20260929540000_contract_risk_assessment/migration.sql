-- CD-158 ประเมินความเสี่ยงกฎหมาย
-- AlterTable
ALTER TABLE "crm_company_configs" ADD COLUMN     "legalRiskOpinionTypeCode" TEXT;

-- CreateTable
CREATE TABLE "contract_risk_assessments" (
    "contractId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "summary" TEXT,
    "issues" JSONB NOT NULL DEFAULT '[]',
    "opinionRequestId" TEXT,
    "opinionError" TEXT,
    "assessedBy" TEXT NOT NULL,
    "assessedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contract_risk_assessments_pkey" PRIMARY KEY ("contractId")
);

-- CreateIndex
CREATE INDEX "contract_risk_assessments_companyId_level_idx" ON "contract_risk_assessments"("companyId", "level");

-- AddForeignKey
ALTER TABLE "contract_risk_assessments" ADD CONSTRAINT "contract_risk_assessments_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "customer_contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE "contract_risk_assessments"
  ADD CONSTRAINT "contract_risk_assessments_level_check"
    CHECK ("level" IN ('low', 'medium', 'high', 'critical'));
