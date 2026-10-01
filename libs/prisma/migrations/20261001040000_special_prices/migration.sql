-- AlterTable
ALTER TABLE "product_prices" ADD COLUMN     "customerId" TEXT,
ADD COLUMN     "opportunityId" TEXT,
ADD COLUMN     "scope" TEXT NOT NULL DEFAULT 'standard',
ADD COLUMN     "segmentValueId" TEXT;

-- CreateIndex
CREATE INDEX "product_prices_companyId_scope_idx" ON "product_prices"("companyId", "scope");

