-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN     "receivingOrgUnitId" TEXT,
ADD COLUMN     "salesAxis" TEXT,
ADD COLUMN     "targetDeals" INTEGER,
ADD COLUMN     "targetLeads" INTEGER,
ADD COLUMN     "targetSales" DECIMAL(14,2);

-- CreateTable
CREATE TABLE "campaign_budget_lines" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "planned" DECIMAL(14,2) NOT NULL,
    "note" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "campaign_budget_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_spends" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "budgetLineId" TEXT,
    "spentOn" DATE NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "vendor" TEXT,
    "note" TEXT,
    "receiptKey" TEXT,
    "receiptName" TEXT,
    "receiptType" TEXT,
    "voidedAt" TIMESTAMP(3),
    "voidedBy" TEXT,
    "voidReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaign_spends_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "campaign_budget_lines_campaignId_idx" ON "campaign_budget_lines"("campaignId");

-- CreateIndex
CREATE INDEX "campaign_spends_campaignId_idx" ON "campaign_spends"("campaignId");

-- CreateIndex
CREATE INDEX "campaign_spends_budgetLineId_idx" ON "campaign_spends"("budgetLineId");

-- AddForeignKey
ALTER TABLE "campaign_budget_lines" ADD CONSTRAINT "campaign_budget_lines_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_spends" ADD CONSTRAINT "campaign_spends_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_spends" ADD CONSTRAINT "campaign_spends_budgetLineId_fkey" FOREIGN KEY ("budgetLineId") REFERENCES "campaign_budget_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

