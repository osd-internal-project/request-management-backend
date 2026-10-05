-- CreateTable
CREATE TABLE "service_handovers" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "acceptanceId" TEXT NOT NULL,
    "milestoneId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'sent',
    "note" TEXT NOT NULL DEFAULT '',
    "snapshot" JSONB NOT NULL DEFAULT '{}',
    "sentBy" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "question" TEXT,
    "questionedBy" TEXT,
    "questionedAt" TIMESTAMP(3),
    "acknowledgedBy" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "ackNote" TEXT,
    "remindedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "service_handovers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "service_handovers_acceptanceId_key" ON "service_handovers"("acceptanceId");

-- CreateIndex
CREATE INDEX "service_handovers_companyId_status_idx" ON "service_handovers"("companyId", "status");

-- CreateIndex
CREATE INDEX "service_handovers_projectId_idx" ON "service_handovers"("projectId");

