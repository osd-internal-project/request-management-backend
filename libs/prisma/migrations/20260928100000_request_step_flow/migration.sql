-- Configurable request flow: per-type steps inside in_progress (additive only).
-- AlterTable
ALTER TABLE "requests" ADD COLUMN     "currentStepCode" TEXT,
ADD COLUMN     "flowVersionId" TEXT,
ADD COLUMN     "parentStepCode" TEXT,
ADD COLUMN     "stepFormData" JSONB NOT NULL DEFAULT '{}';

-- CreateTable
CREATE TABLE "request_flow_versions" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "requestTypeId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedBy" TEXT,

    CONSTRAINT "request_flow_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "request_flow_steps" (
    "id" TEXT NOT NULL,
    "flowVersionId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "formSchema" JSONB,
    "subRequestTypes" JSONB NOT NULL DEFAULT '[]',
    "requiresApproval" BOOLEAN NOT NULL DEFAULT false,
    "assigneeRule" JSONB,
    "slaHours" INTEGER,

    CONSTRAINT "request_flow_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "request_flow_transitions" (
    "id" TEXT NOT NULL,
    "flowVersionId" TEXT NOT NULL,
    "fromStepCode" TEXT NOT NULL,
    "toStepCode" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "condition" JSONB,
    "backward" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "request_flow_transitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "request_step_runs" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "stepCode" TEXT NOT NULL,
    "enteredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "enteredBy" TEXT,
    "leftAt" TIMESTAMP(3),
    "outcome" TEXT,

    CONSTRAINT "request_step_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "request_flow_versions_companyId_requestTypeId_version_key" ON "request_flow_versions"("companyId", "requestTypeId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "request_flow_steps_flowVersionId_code_key" ON "request_flow_steps"("flowVersionId", "code");

-- CreateIndex
CREATE INDEX "request_flow_transitions_flowVersionId_fromStepCode_idx" ON "request_flow_transitions"("flowVersionId", "fromStepCode");

-- CreateIndex
CREATE INDEX "request_step_runs_requestId_enteredAt_idx" ON "request_step_runs"("requestId", "enteredAt");

-- AddForeignKey
ALTER TABLE "requests" ADD CONSTRAINT "requests_flowVersionId_fkey" FOREIGN KEY ("flowVersionId") REFERENCES "request_flow_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "request_flow_versions" ADD CONSTRAINT "request_flow_versions_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "request_flow_versions" ADD CONSTRAINT "request_flow_versions_requestTypeId_fkey" FOREIGN KEY ("requestTypeId") REFERENCES "request_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "request_flow_steps" ADD CONSTRAINT "request_flow_steps_flowVersionId_fkey" FOREIGN KEY ("flowVersionId") REFERENCES "request_flow_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "request_flow_transitions" ADD CONSTRAINT "request_flow_transitions_flowVersionId_fkey" FOREIGN KEY ("flowVersionId") REFERENCES "request_flow_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "request_step_runs" ADD CONSTRAINT "request_step_runs_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

