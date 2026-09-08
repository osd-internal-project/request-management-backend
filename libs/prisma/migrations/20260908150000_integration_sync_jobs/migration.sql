-- CreateEnum
CREATE TYPE "IntegrationJobStatus" AS ENUM ('pending', 'succeeded', 'failed');

-- CreateTable
CREATE TABLE "integration_sync_jobs" (
    "id" TEXT NOT NULL,
    "system" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "status" "IntegrationJobStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "runAfter" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integration_sync_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "integration_sync_jobs_system_status_runAfter_idx" ON "integration_sync_jobs"("system", "status", "runAfter");

-- CreateIndex
CREATE INDEX "integration_sync_jobs_system_kind_resourceId_idx" ON "integration_sync_jobs"("system", "kind", "resourceId");
