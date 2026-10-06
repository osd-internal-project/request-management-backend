-- CreateTable
CREATE TABLE "smart_sources" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "salesAxis" TEXT,
    "criteria" JSONB NOT NULL DEFAULT '{}',
    "intervalHours" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "smart_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "smart_sweep_runs" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "found" INTEGER NOT NULL DEFAULT 0,
    "added" INTEGER NOT NULL DEFAULT 0,
    "duplicates" INTEGER NOT NULL DEFAULT 0,
    "rejected" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "startedBy" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "smart_sweep_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "smart_prospects" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "runId" TEXT,
    "externalRef" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "taxId" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "website" TEXT,
    "industry" TEXT,
    "province" TEXT,
    "registeredCapital" DECIMAL(16,2),
    "salesAxis" TEXT,
    "evidence" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'new',
    "discardReason" TEXT,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "smart_prospects_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "smart_sources_companyId_code_key" ON "smart_sources"("companyId", "code");

-- CreateIndex
CREATE INDEX "smart_sweep_runs_companyId_sourceId_startedAt_idx" ON "smart_sweep_runs"("companyId", "sourceId", "startedAt");

-- CreateIndex
CREATE INDEX "smart_prospects_companyId_status_createdAt_idx" ON "smart_prospects"("companyId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "smart_prospects_companyId_taxId_idx" ON "smart_prospects"("companyId", "taxId");

-- CreateIndex
CREATE UNIQUE INDEX "smart_prospects_companyId_sourceId_externalRef_key" ON "smart_prospects"("companyId", "sourceId", "externalRef");

