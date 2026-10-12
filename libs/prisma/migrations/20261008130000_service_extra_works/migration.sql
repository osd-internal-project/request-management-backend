-- CD-228 บำรุงรักษาและสนับสนุน: work found outside the contract after a job started, agreed or declined by the customer, charged on the job's billing.
-- CreateTable
CREATE TABLE "service_extra_works" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "workOrderId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "estimate" DECIMAL(14,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "ackName" TEXT,
    "ackOn" DATE,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "declineNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "service_extra_works_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "service_extra_works_companyId_status_idx" ON "service_extra_works"("companyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "service_extra_works_workOrderId_seq_key" ON "service_extra_works"("workOrderId", "seq");

