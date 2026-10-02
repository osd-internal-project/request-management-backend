-- CreateTable
CREATE TABLE "project_acceptances" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "milestoneId" TEXT,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "location" TEXT,
    "customerPeople" TEXT,
    "preparation" TEXT,
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "decidedOn" DATE,
    "outcomeNote" TEXT,
    "certificateKey" TEXT,
    "certificateName" TEXT,
    "certificateMime" TEXT,
    "certificateSize" INTEGER,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "project_acceptances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_acceptance_items" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "acceptanceId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "dueOn" DATE NOT NULL,
    "ownerUserId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "doneNote" TEXT,
    "doneAt" TIMESTAMP(3),
    "doneBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_acceptance_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_acceptances_projectId_status_idx" ON "project_acceptances"("projectId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "project_acceptances_projectId_seq_key" ON "project_acceptances"("projectId", "seq");

-- CreateIndex
CREATE INDEX "project_acceptance_items_status_dueOn_idx" ON "project_acceptance_items"("status", "dueOn");

-- CreateIndex
CREATE UNIQUE INDEX "project_acceptance_items_acceptanceId_seq_key" ON "project_acceptance_items"("acceptanceId", "seq");

-- AddForeignKey
ALTER TABLE "project_acceptances" ADD CONSTRAINT "project_acceptances_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_acceptance_items" ADD CONSTRAINT "project_acceptance_items_acceptanceId_fkey" FOREIGN KEY ("acceptanceId") REFERENCES "project_acceptances"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

