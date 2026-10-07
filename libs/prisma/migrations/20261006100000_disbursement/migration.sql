-- การเบิก (docs/disbursement.md): new tables only, no existing table is touched.

-- CreateTable
CREATE TABLE "disbursement_settings" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "advanceTypeCode" TEXT,
    "pettyCashTypeCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "disbursement_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "disbursements" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "docNo" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "requestNo" TEXT,
    "requesterId" TEXT NOT NULL,
    "orgUnitId" TEXT,
    "payee" TEXT,
    "costCenter" TEXT,
    "purpose" TEXT,
    "neededBy" DATE,
    "clearBy" DATE,
    "soNo" TEXT,
    "soSubject" TEXT,
    "ticketNo" TEXT,
    "projectCode" TEXT,
    "fundId" TEXT,
    "status" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'THB',
    "requestedAmount" DECIMAL(14,2) NOT NULL,
    "paidAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "actualAmount" DECIMAL(14,2),
    "refundAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "extraPaidAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "verifyChecks" JSONB,
    "verifyNote" TEXT,
    "verifiedBy" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "execCaseId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "paidBy" TEXT,
    "paidAt" TIMESTAMP(3),
    "clearingAt" TIMESTAMP(3),
    "closedBy" TEXT,
    "closedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "replenishmentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "disbursements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "disbursement_lines" (
    "id" TEXT NOT NULL,
    "disbursementId" TEXT NOT NULL,
    "phase" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "costCenter" TEXT,
    "amount" DECIMAL(14,2) NOT NULL,
    "note" TEXT,
    "receiptDate" DATE,
    "receiptFileKey" TEXT,

    CONSTRAINT "disbursement_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "disbursement_movements" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "disbursementId" TEXT,
    "fundId" TEXT,
    "replenishmentId" TEXT,
    "type" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "method" TEXT,
    "reference" TEXT,
    "evidenceFileKey" TEXT,
    "note" TEXT,
    "actedBy" TEXT NOT NULL,
    "actedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "disbursement_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "petty_cash_funds" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "custodianUserId" TEXT NOT NULL,
    "orgUnitId" TEXT,
    "imprestAmount" DECIMAL(14,2) NOT NULL,
    "perClaimLimit" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'THB',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "petty_cash_funds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "petty_cash_replenishments" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "docNo" TEXT NOT NULL,
    "fundId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "totalAmount" DECIMAL(14,2) NOT NULL,
    "approvalCaseId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "paidBy" TEXT,
    "paidAt" TIMESTAMP(3),
    "paymentRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "petty_cash_replenishments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "disbursement_settings_companyId_key" ON "disbursement_settings"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "disbursements_requestId_key" ON "disbursements"("requestId");

-- CreateIndex
CREATE INDEX "disbursements_companyId_kind_status_idx" ON "disbursements"("companyId", "kind", "status");

-- CreateIndex
CREATE INDEX "disbursements_companyId_requesterId_idx" ON "disbursements"("companyId", "requesterId");

-- CreateIndex
CREATE INDEX "disbursements_fundId_replenishmentId_idx" ON "disbursements"("fundId", "replenishmentId");

-- CreateIndex
CREATE UNIQUE INDEX "disbursements_companyId_docNo_key" ON "disbursements"("companyId", "docNo");

-- CreateIndex
CREATE UNIQUE INDEX "disbursement_lines_disbursementId_phase_lineNo_key" ON "disbursement_lines"("disbursementId", "phase", "lineNo");

-- CreateIndex
CREATE INDEX "disbursement_movements_fundId_idx" ON "disbursement_movements"("fundId");

-- CreateIndex
CREATE INDEX "disbursement_movements_disbursementId_idx" ON "disbursement_movements"("disbursementId");

-- CreateIndex
CREATE UNIQUE INDEX "petty_cash_funds_companyId_code_key" ON "petty_cash_funds"("companyId", "code");

-- CreateIndex
CREATE INDEX "petty_cash_replenishments_fundId_status_idx" ON "petty_cash_replenishments"("fundId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "petty_cash_replenishments_companyId_docNo_key" ON "petty_cash_replenishments"("companyId", "docNo");

-- AddForeignKey
ALTER TABLE "disbursement_lines" ADD CONSTRAINT "disbursement_lines_disbursementId_fkey" FOREIGN KEY ("disbursementId") REFERENCES "disbursements"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Run-number settings for the three new document types, one row per company.
-- Yearly reset, Thai time (run-number-service). Editable from the admin screen.
INSERT INTO "run_number_settings" (
  "id", "companyId", "docType", "scopeKey", "pattern",
  "seqPadding", "startNumber", "resetPeriod", "active", "updatedAt"
)
SELECT gen_random_uuid()::text, c."id", d."docType", '*', d."pattern",
       5, 1, 'yearly'::"RunNumberResetPeriod", true, CURRENT_TIMESTAMP
FROM "companies" c
CROSS JOIN (
  VALUES
    ('ADVANCE',         'ADV-{COMPANY_PREFIX}-{YYYY}-{SEQ}'),
    ('PETTY_CASH',      'PC-{COMPANY_PREFIX}-{YYYY}-{SEQ}'),
    ('PETTY_REPLENISH', 'PCR-{COMPANY_PREFIX}-{YYYY}-{SEQ}')
) AS d("docType", "pattern")
ON CONFLICT DO NOTHING;
