-- AlterTable
ALTER TABLE "quotation_lines" ADD COLUMN     "priceId" TEXT;

-- CreateTable
CREATE TABLE "product_price_versions" (
    "id" TEXT NOT NULL,
    "priceId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "versionNo" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "unitPrice" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "validFrom" DATE NOT NULL,
    "validTo" DATE,
    "note" TEXT NOT NULL DEFAULT '',
    "reason" TEXT NOT NULL DEFAULT '',
    "changedBy" TEXT NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_price_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "product_price_versions_priceId_versionNo_key" ON "product_price_versions"("priceId", "versionNo");

-- AddForeignKey
ALTER TABLE "product_price_versions" ADD CONSTRAINT "product_price_versions_priceId_fkey" FOREIGN KEY ("priceId") REFERENCES "product_prices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- CD-195: prices saved before the history existed start at version 1.
INSERT INTO "product_price_versions" ("id", "priceId", "companyId", "versionNo", "action", "unitPrice", "currency", "validFrom", "validTo", "note", "reason", "changedBy", "changedAt")
SELECT gen_random_uuid()::text, p."id", p."companyId", 1, CASE WHEN p."deletedAt" IS NULL THEN 'created' ELSE 'removed' END,
       p."unitPrice", p."currency", p."validFrom", p."validTo", p."note", '', COALESCE(p."updatedBy", p."createdBy"), p."updatedAt"
FROM "product_prices" p;
