-- AlterTable
ALTER TABLE "crm_company_configs" ADD COLUMN     "deliveryBillingExceptionTypeCode" TEXT;

-- CreateTable
CREATE TABLE "installment_invoices" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'THB',
    "amount" DECIMAL(14,2) NOT NULL,
    "acceptanceId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'none',
    "note" TEXT,
    "exceptionStatus" TEXT NOT NULL DEFAULT 'none',
    "exceptionRequestId" TEXT,
    "exceptionReason" TEXT,
    "confirmedBy" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "cancelledBy" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "erpStatus" TEXT NOT NULL DEFAULT 'none',
    "erpDraftNo" TEXT,
    "erpLastError" TEXT,
    "erpSyncedAt" TIMESTAMP(3),
    "erpInvoiceStatus" TEXT,
    "erpInvoiceNo" TEXT,
    "erpInvoiceTotal" DECIMAL(14,2),
    "erpPaid" DECIMAL(14,2),
    "erpCheckedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "installment_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "retention_reminders" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "dueOn" DATE NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "retention_reminders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "installment_invoices_exceptionRequestId_key" ON "installment_invoices"("exceptionRequestId");

-- CreateIndex
CREATE INDEX "installment_invoices_projectId_idx" ON "installment_invoices"("projectId");

-- CreateIndex
CREATE INDEX "installment_invoices_erpStatus_erpCheckedAt_idx" ON "installment_invoices"("erpStatus", "erpCheckedAt");

-- CreateIndex
CREATE UNIQUE INDEX "installment_invoices_contractId_seq_key" ON "installment_invoices"("contractId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "installment_invoices_companyId_reference_key" ON "installment_invoices"("companyId", "reference");

-- CreateIndex
CREATE UNIQUE INDEX "retention_reminders_contractId_seq_dueOn_key" ON "retention_reminders"("contractId", "seq", "dueOn");

