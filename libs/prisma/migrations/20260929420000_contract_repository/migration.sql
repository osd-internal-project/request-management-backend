-- CreateEnum
CREATE TYPE "ContractKind" AS ENUM ('standard', 'nda', 'msa', 'other');

-- AlterTable
ALTER TABLE "customer_contracts" ADD COLUMN     "confidential" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "counterpartyName" TEXT,
ADD COLUMN     "counterpartyTaxId" TEXT,
ADD COLUMN     "kind" "ContractKind" NOT NULL DEFAULT 'standard',
ALTER COLUMN "customerId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "contract_documents" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "textStatus" TEXT NOT NULL,
    "textContent" TEXT,
    "uploadedBy" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "contract_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contract_access" (
    "contractId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "grantedBy" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contract_access_pkey" PRIMARY KEY ("contractId","userId")
);

-- CreateIndex
CREATE INDEX "contract_documents_contractId_idx" ON "contract_documents"("contractId");

-- CreateIndex
CREATE INDEX "contract_access_userId_idx" ON "contract_access"("userId");

-- AddForeignKey
ALTER TABLE "contract_documents" ADD CONSTRAINT "contract_documents_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "customer_contracts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_access" ADD CONSTRAINT "contract_access_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "customer_contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- CD-161: a contract is with a registered customer or a named counterparty.
ALTER TABLE "customer_contracts" ADD CONSTRAINT "customer_contracts_party_check"
  CHECK ("customerId" IS NOT NULL OR "counterpartyName" IS NOT NULL);
