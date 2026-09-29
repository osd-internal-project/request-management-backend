-- AlterTable
ALTER TABLE "customer_contracts" ADD COLUMN     "masterContractId" TEXT,
ADD COLUMN     "ndaDirection" TEXT,
ADD COLUMN     "ndaScope" TEXT;

-- CreateIndex
CREATE INDEX "customer_contracts_masterContractId_idx" ON "customer_contracts"("masterContractId");

-- AddForeignKey
ALTER TABLE "customer_contracts" ADD CONSTRAINT "customer_contracts_masterContractId_fkey" FOREIGN KEY ("masterContractId") REFERENCES "customer_contracts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

