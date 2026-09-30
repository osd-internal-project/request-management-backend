-- CD-159 อนุมัติสัญญา: ประเมินความเสี่ยงบนร่างได้ด้วย และการขออนุมัติรายฉบับ

-- A risk assessment may now belong to a draft (before its contract exists).
-- Existing rows keep their contract and get an id of their own.
ALTER TABLE "contract_risk_assessments"
  ADD COLUMN "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  ADD COLUMN "draftId" TEXT;
ALTER TABLE "contract_risk_assessments" ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "contract_risk_assessments"
  DROP CONSTRAINT "contract_risk_assessments_pkey",
  ADD CONSTRAINT "contract_risk_assessments_pkey" PRIMARY KEY ("id"),
  ALTER COLUMN "contractId" DROP NOT NULL;
CREATE UNIQUE INDEX "contract_risk_assessments_contractId_key" ON "contract_risk_assessments"("contractId");
CREATE UNIQUE INDEX "contract_risk_assessments_draftId_key" ON "contract_risk_assessments"("draftId");
ALTER TABLE "contract_risk_assessments" ADD CONSTRAINT "contract_risk_assessments_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "contract_drafts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "contract_risk_assessments"
  ADD CONSTRAINT "contract_risk_assessments_subject_check"
    CHECK ("contractId" IS NOT NULL OR "draftId" IS NOT NULL);

-- AlterTable
ALTER TABLE "crm_company_configs" ADD COLUMN     "contractApprovalTypeCode" TEXT;

-- CreateTable
CREATE TABLE "contract_draft_approvals" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "draftId" TEXT NOT NULL,
    "versionNo" INTEGER NOT NULL,
    "requestId" TEXT,
    "error" TEXT,
    "riskLevel" TEXT,
    "requestedBy" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voidedAt" TIMESTAMP(3),
    "voidReason" TEXT,

    CONSTRAINT "contract_draft_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "contract_draft_approvals_draftId_voidedAt_idx" ON "contract_draft_approvals"("draftId", "voidedAt");

-- AddForeignKey
ALTER TABLE "contract_draft_approvals" ADD CONSTRAINT "contract_draft_approvals_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "contract_drafts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
