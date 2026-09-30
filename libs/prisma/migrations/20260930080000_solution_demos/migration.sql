-- CreateEnum
CREATE TYPE "SolutionDemoKind" AS ENUM ('demo', 'poc');

-- CreateEnum
CREATE TYPE "SolutionDemoStatus" AS ENUM ('planned', 'done', 'cancelled');

-- AlterTable
ALTER TABLE "crm_company_configs" ADD COLUMN     "demoRequestTypeCode" TEXT;

-- CreateTable
CREATE TABLE "solution_demos" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "solutionId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "requestId" TEXT,
    "kind" "SolutionDemoKind" NOT NULL DEFAULT 'demo',
    "title" TEXT NOT NULL,
    "scheduledOn" DATE,
    "site" TEXT NOT NULL DEFAULT '',
    "people" TEXT NOT NULL DEFAULT '',
    "plan" TEXT NOT NULL DEFAULT '',
    "criteria" JSONB NOT NULL DEFAULT '[]',
    "outcome" TEXT NOT NULL DEFAULT '',
    "status" "SolutionDemoStatus" NOT NULL DEFAULT 'planned',
    "closedAt" TIMESTAMP(3),
    "closedBy" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "solution_demos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "solution_demo_equipment" (
    "id" TEXT NOT NULL,
    "demoId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "serial" TEXT NOT NULL DEFAULT '',
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "takenBy" TEXT NOT NULL DEFAULT '',
    "outOn" DATE NOT NULL,
    "returnedOn" DATE,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "solution_demo_equipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "solution_demo_findings" (
    "id" TEXT NOT NULL,
    "demoId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "requiresChange" BOOLEAN NOT NULL DEFAULT false,
    "recordedOnVersionNo" INTEGER NOT NULL,
    "resolvedVersionNo" INTEGER,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "solution_demo_findings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "solution_demos_requestId_key" ON "solution_demos"("requestId");

-- CreateIndex
CREATE INDEX "solution_demos_solutionId_idx" ON "solution_demos"("solutionId");

-- CreateIndex
CREATE INDEX "solution_demo_equipment_demoId_idx" ON "solution_demo_equipment"("demoId");

-- CreateIndex
CREATE INDEX "solution_demo_findings_demoId_idx" ON "solution_demo_findings"("demoId");

-- AddForeignKey
ALTER TABLE "solution_demos" ADD CONSTRAINT "solution_demos_solutionId_fkey" FOREIGN KEY ("solutionId") REFERENCES "solutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "solution_demo_equipment" ADD CONSTRAINT "solution_demo_equipment_demoId_fkey" FOREIGN KEY ("demoId") REFERENCES "solution_demos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "solution_demo_findings" ADD CONSTRAINT "solution_demo_findings_demoId_fkey" FOREIGN KEY ("demoId") REFERENCES "solution_demos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

