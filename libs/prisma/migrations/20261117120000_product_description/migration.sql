-- What a product is, from its brochure (17 Nov 2026). Nullable: SAP-synced rows carry no description.

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "description" TEXT;
