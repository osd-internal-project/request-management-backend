-- การเบิก v3: created after the request is approved; instalments, voids, refunds on the movement ledger;
-- Cost Center master; clearing reminders. Additive only — every new column is nullable.

-- AlterTable
ALTER TABLE "disbursement_settings" ADD COLUMN     "clearReminderDays" INTEGER;

-- AlterTable
ALTER TABLE "disbursements" ADD COLUMN     "clearRemindedAt" TIMESTAMP(3),
ADD COLUMN     "sourceSnapshot" JSONB;

-- AlterTable
ALTER TABLE "disbursement_movements" ADD COLUMN     "counterpartyUserId" TEXT,
ADD COLUMN     "occurredAt" TIMESTAMP(3),
ADD COLUMN     "reversesId" TEXT;

-- CreateTable
CREATE TABLE "cost_centers" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "orgUnitId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "cost_centers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cost_centers_companyId_active_idx" ON "cost_centers"("companyId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "cost_centers_companyId_code_key" ON "cost_centers"("companyId", "code");
