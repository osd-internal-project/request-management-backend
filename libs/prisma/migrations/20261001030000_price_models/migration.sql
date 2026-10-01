-- AlterTable
ALTER TABLE "product_price_versions" ADD COLUMN     "priceModel" TEXT NOT NULL DEFAULT 'unit';

-- AlterTable
ALTER TABLE "product_prices" ADD COLUMN     "priceModel" TEXT NOT NULL DEFAULT 'unit';

-- AlterTable
ALTER TABLE "quotation_lines" ADD COLUMN     "priceModel" TEXT NOT NULL DEFAULT 'unit',
ADD COLUMN     "termMonths" INTEGER;

