-- CreateTable
CREATE TABLE "service_billings" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "workOrderId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "currency" TEXT NOT NULL DEFAULT 'THB',
    "netTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "note" TEXT,
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

    CONSTRAINT "service_billings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_billing_lines" (
    "id" TEXT NOT NULL,
    "billingId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "productCode" TEXT,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "unit" TEXT,
    "unitPrice" DECIMAL(14,2) NOT NULL,
    "discountPct" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "lineTotal" DECIMAL(14,2) NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'manual',

    CONSTRAINT "service_billing_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "service_billings_workOrderId_key" ON "service_billings"("workOrderId");

-- CreateIndex
CREATE INDEX "service_billings_companyId_status_idx" ON "service_billings"("companyId", "status");

-- CreateIndex
CREATE INDEX "service_billings_erpStatus_erpCheckedAt_idx" ON "service_billings"("erpStatus", "erpCheckedAt");

-- CreateIndex
CREATE UNIQUE INDEX "service_billings_companyId_reference_key" ON "service_billings"("companyId", "reference");

-- CreateIndex
CREATE UNIQUE INDEX "service_billing_lines_billingId_lineNo_key" ON "service_billing_lines"("billingId", "lineNo");

-- AddForeignKey
ALTER TABLE "service_billing_lines" ADD CONSTRAINT "service_billing_lines_billingId_fkey" FOREIGN KEY ("billingId") REFERENCES "service_billings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

