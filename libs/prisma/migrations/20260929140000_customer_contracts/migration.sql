-- CreateEnum
CREATE TYPE "CustomerContractStatus" AS ENUM ('active', 'renewed', 'ended', 'cancelled');

-- CreateTable
CREATE TABLE "customer_contracts" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "contractNo" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "startOn" DATE,
    "endOn" DATE NOT NULL,
    "value" DECIMAL(14,2),
    "currency" TEXT NOT NULL DEFAULT 'THB',
    "status" "CustomerContractStatus" NOT NULL DEFAULT 'active',
    "opportunityId" TEXT,
    "requestId" TEXT,
    "ownerUserId" TEXT NOT NULL,
    "ownerOrgUnitId" TEXT,
    "renewalOpportunityId" TEXT,
    "renewalCreatedAt" TIMESTAMP(3),
    "reminded60At" TIMESTAMP(3),
    "reminded30At" TIMESTAMP(3),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "customer_contracts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "customer_contracts_requestId_key" ON "customer_contracts"("requestId");

-- CreateIndex
CREATE INDEX "customer_contracts_customerId_idx" ON "customer_contracts"("customerId");

-- CreateIndex
CREATE INDEX "customer_contracts_status_endOn_idx" ON "customer_contracts"("status", "endOn");

-- CreateIndex
CREATE UNIQUE INDEX "customer_contracts_companyId_contractNo_key" ON "customer_contracts"("companyId", "contractNo");

-- AddForeignKey
ALTER TABLE "customer_contracts" ADD CONSTRAINT "customer_contracts_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

