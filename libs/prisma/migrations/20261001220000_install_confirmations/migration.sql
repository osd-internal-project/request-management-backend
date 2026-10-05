-- CreateTable
CREATE TABLE "project_install_confirmations" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "milestoneId" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "checks" JSONB NOT NULL DEFAULT '[]',
    "confirmedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedBy" TEXT NOT NULL,

    CONSTRAINT "project_install_confirmations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "project_install_confirmations_milestoneId_key" ON "project_install_confirmations"("milestoneId");

-- CreateIndex
CREATE INDEX "project_install_confirmations_projectId_idx" ON "project_install_confirmations"("projectId");

