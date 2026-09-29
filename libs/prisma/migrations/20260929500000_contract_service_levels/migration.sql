-- AlterTable
ALTER TABLE "contract_terms" ADD COLUMN     "availabilityPct" DECIMAL(6,3),
ADD COLUMN     "serviceCoverage" "SlaCoverage",
ADD COLUMN     "serviceLevels" JSONB,
ADD COLUMN     "serviceReportEvery" TEXT;

