-- CreateTable
CREATE TABLE "integration_calls" (
    "id" TEXT NOT NULL,
    "integrationId" TEXT,
    "apiKeyId" TEXT,
    "companyId" TEXT,
    "method" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "actorUserId" TEXT,
    "status" INTEGER NOT NULL,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integration_calls_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "integration_calls_integrationId_createdAt_idx" ON "integration_calls"("integrationId", "createdAt");

-- CreateIndex
CREATE INDEX "integration_calls_companyId_createdAt_idx" ON "integration_calls"("companyId", "createdAt");
