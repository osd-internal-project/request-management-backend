-- AlterTable
ALTER TABLE "products" ADD COLUMN     "groupCode" TEXT,
ADD COLUMN     "groupName" TEXT;

-- AlterTable
ALTER TABLE "quotation_lines" ADD COLUMN     "markupPct" DECIMAL(7,2),
ADD COLUMN     "workType" TEXT;

-- CreateTable
CREATE TABLE "markup_rules" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "workType" TEXT,
    "productGroupCode" TEXT,
    "segmentValueId" TEXT,
    "markupPct" DECIMAL(7,2) NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "markup_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "markup_rules_companyId_active_idx" ON "markup_rules"("companyId", "active");

