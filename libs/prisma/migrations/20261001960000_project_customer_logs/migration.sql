-- CreateTable
CREATE TABLE "project_customer_logs" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "occurredOn" DATE NOT NULL,
    "contactName" TEXT,
    "summary" TEXT NOT NULL,
    "decision" TEXT,
    "affectsScope" BOOLEAN NOT NULL DEFAULT false,
    "changeRequestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "project_customer_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_customer_logs_projectId_occurredOn_idx" ON "project_customer_logs"("projectId", "occurredOn");

-- CreateIndex
CREATE UNIQUE INDEX "project_customer_logs_projectId_seq_key" ON "project_customer_logs"("projectId", "seq");

-- AddForeignKey
ALTER TABLE "project_customer_logs" ADD CONSTRAINT "project_customer_logs_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

