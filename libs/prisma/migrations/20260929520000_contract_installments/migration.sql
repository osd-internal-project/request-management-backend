-- CD-164 แผนการวางบิลตามงวด
-- CreateTable
CREATE TABLE "contract_installments" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "dueOn" DATE,
    "dueNote" TEXT,
    "milestone" TEXT,
    "guaranteeType" TEXT,
    "guaranteeAmount" DECIMAL(14,2),
    "guaranteeRef" TEXT,
    "guaranteeExpiresOn" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contract_installments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "contract_installments_contractId_seq_key" ON "contract_installments"("contractId", "seq");

-- AddForeignKey
ALTER TABLE "contract_installments" ADD CONSTRAINT "contract_installments_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "customer_contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE "contract_installments"
  ADD CONSTRAINT "contract_installments_amount_positive" CHECK ("amount" > 0),
  ADD CONSTRAINT "contract_installments_kind_check"
    CHECK ("kind" IN ('deposit', 'progress', 'final', 'retention'));
