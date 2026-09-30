-- CreateTable
CREATE TABLE "product_prices" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "productCode" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'THB',
    "unitPrice" DECIMAL(14,2) NOT NULL,
    "validFrom" DATE NOT NULL,
    "validTo" DATE,
    "note" TEXT NOT NULL DEFAULT '',
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "product_prices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_prices_companyId_productCode_currency_idx" ON "product_prices"("companyId", "productCode", "currency");

