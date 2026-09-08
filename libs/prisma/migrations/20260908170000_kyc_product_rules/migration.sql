-- CreateTable
CREATE TABLE "kyc_product_rules" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "productCode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "kyc_product_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "kyc_product_rules_companyId_productCode_key" ON "kyc_product_rules"("companyId", "productCode");

-- AddForeignKey
ALTER TABLE "kyc_product_rules" ADD CONSTRAINT "kyc_product_rules_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
