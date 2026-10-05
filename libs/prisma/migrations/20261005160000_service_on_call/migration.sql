-- AlterTable
ALTER TABLE "crm_company_configs" ADD COLUMN     "serviceOnCallEscalateMinutes" INTEGER NOT NULL DEFAULT 30;

-- CreateTable
CREATE TABLE "service_on_call_shifts" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "startOn" DATE NOT NULL,
    "endOn" DATE NOT NULL,
    "primaryUserId" TEXT NOT NULL,
    "backupUserId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "service_on_call_shifts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_on_call_dispatches" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "shiftId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "previousReceiverUserId" TEXT,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "escalatedAt" TIMESTAMP(3),
    "escalatedFromUserId" TEXT,
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "service_on_call_dispatches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "service_on_call_shifts_companyId_startOn_idx" ON "service_on_call_shifts"("companyId", "startOn");

-- CreateIndex
CREATE UNIQUE INDEX "service_on_call_dispatches_requestId_key" ON "service_on_call_dispatches"("requestId");

-- CreateIndex
CREATE INDEX "service_on_call_dispatches_settledAt_sentAt_idx" ON "service_on_call_dispatches"("settledAt", "sentAt");

