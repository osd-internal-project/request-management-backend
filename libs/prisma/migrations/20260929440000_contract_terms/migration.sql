-- AlterTable
ALTER TABLE "crm_company_configs" ADD COLUMN     "liabilityApprovalRequestTypeCode" TEXT;

-- CreateTable
CREATE TABLE "contract_terms" (
    "contractId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "liabilityUnlimited" BOOLEAN NOT NULL DEFAULT false,
    "liabilityCapAmount" DECIMAL(14,2),
    "liabilityNote" TEXT,
    "liabilityApprovalRequestId" TEXT,
    "liabilityApprovalError" TEXT,
    "penaltyRatePct" DECIMAL(7,4),
    "penaltyPeriod" TEXT,
    "penaltyBasis" TEXT,
    "penaltyBasisNote" TEXT,
    "penaltyCapPct" DECIMAL(7,4),
    "penaltyCapAmount" DECIMAL(14,2),
    "warrantyMonths" INTEGER,
    "warrantyScope" TEXT,
    "warrantyExclusions" TEXT,
    "acceptedOn" DATE,
    "terminationNoticeDays" INTEGER,
    "terminationConditions" TEXT,
    "terminationConsequences" TEXT,
    "terminationSteps" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "contract_terms_pkey" PRIMARY KEY ("contractId")
);

-- CreateIndex
CREATE INDEX "contract_terms_companyId_idx" ON "contract_terms"("companyId");

-- AddForeignKey
ALTER TABLE "contract_terms" ADD CONSTRAINT "contract_terms_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "customer_contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

