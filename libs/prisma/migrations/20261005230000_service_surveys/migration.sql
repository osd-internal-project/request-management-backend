-- CreateTable
CREATE TABLE "service_surveys" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "workOrderId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "customerId" TEXT,
    "assigneeUserId" TEXT,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "sentVia" TEXT NOT NULL DEFAULT 'none',
    "sentTo" TEXT,
    "sentAt" TIMESTAMP(3),
    "answeredAt" TIMESTAMP(3),
    "overall" INTEGER,
    "speed" INTEGER,
    "technician" INTEGER,
    "outcome" INTEGER,
    "comment" TEXT,
    "lowAlertedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_surveys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "service_surveys_workOrderId_key" ON "service_surveys"("workOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "service_surveys_tokenHash_key" ON "service_surveys"("tokenHash");

-- CreateIndex
CREATE INDEX "service_surveys_companyId_answeredAt_idx" ON "service_surveys"("companyId", "answeredAt");

-- CreateIndex
CREATE INDEX "service_surveys_customerId_answeredAt_idx" ON "service_surveys"("customerId", "answeredAt");

