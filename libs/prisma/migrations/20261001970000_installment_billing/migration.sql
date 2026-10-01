-- CreateTable
CREATE TABLE "contract_installment_billings" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "invoiceNo" TEXT,
    "invoicedOn" DATE,
    "invoicedAmount" DECIMAL(14,2),
    "paidOn" DATE,
    "paidAmount" DECIMAL(14,2),
    "source" TEXT NOT NULL DEFAULT 'manual',
    "note" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recordedBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contract_installment_billings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "contract_installment_billings_contractId_seq_key" ON "contract_installment_billings"("contractId", "seq");

