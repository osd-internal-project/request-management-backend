-- CreateEnum
CREATE TYPE "KycRiskLevel" AS ENUM ('low', 'medium', 'high');

-- CreateEnum
CREATE TYPE "KycRecordStatus" AS ENUM ('verified', 'screening_hit', 'superseded', 'expired');

-- AlterTable
ALTER TABLE "crm_company_configs" ADD COLUMN     "kycReviewMonthsHigh" INTEGER NOT NULL DEFAULT 12,
ADD COLUMN     "kycReviewMonthsLow" INTEGER NOT NULL DEFAULT 36,
ADD COLUMN     "kycReviewMonthsMedium" INTEGER NOT NULL DEFAULT 24;

-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "kycExpiresOn" DATE,
ADD COLUMN     "kycRiskLevel" "KycRiskLevel";

-- CreateTable
CREATE TABLE "kyc_watchlist_entries" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "taxId" TEXT,
    "reason" TEXT NOT NULL,
    "source" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "kyc_watchlist_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_kyc_records" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "requestId" TEXT,
    "status" "KycRecordStatus" NOT NULL,
    "riskLevel" "KycRiskLevel" NOT NULL,
    "suggestedRisk" "KycRiskLevel" NOT NULL,
    "screening" JSONB NOT NULL,
    "clearanceNote" TEXT,
    "documentsExpireOn" DATE,
    "signatories" TEXT,
    "reviewDueOn" DATE NOT NULL,
    "expiresOn" DATE NOT NULL,
    "warnedAt" TIMESTAMP(3),
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recordedBy" TEXT,

    CONSTRAINT "customer_kyc_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "kyc_watchlist_entries_companyId_active_idx" ON "kyc_watchlist_entries"("companyId", "active");

-- CreateIndex
CREATE INDEX "customer_kyc_records_customerId_recordedAt_idx" ON "customer_kyc_records"("customerId", "recordedAt");

-- CreateIndex
CREATE INDEX "customer_kyc_records_status_expiresOn_idx" ON "customer_kyc_records"("status", "expiresOn");

-- AddForeignKey
ALTER TABLE "kyc_watchlist_entries" ADD CONSTRAINT "kyc_watchlist_entries_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_kyc_records" ADD CONSTRAINT "customer_kyc_records_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

