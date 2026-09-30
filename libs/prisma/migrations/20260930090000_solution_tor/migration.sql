-- CreateEnum
CREATE TYPE "TorCompliance" AS ENUM ('unanswered', 'comply', 'partial', 'not_comply');

-- CreateTable
CREATE TABLE "solution_tors" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "solutionId" TEXT NOT NULL,
    "buyer" TEXT NOT NULL DEFAULT '',
    "projectNo" TEXT NOT NULL DEFAULT '',
    "submissionDeadline" TIMESTAMP(3),
    "bidBond" TEXT NOT NULL DEFAULT '',
    "note" TEXT NOT NULL DEFAULT '',
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "solution_tors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "solution_tor_files" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "solutionId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "uploadedBy" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "solution_tor_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "solution_tor_clauses" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "solutionId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "clauseNo" TEXT NOT NULL DEFAULT '',
    "text" TEXT NOT NULL,
    "mandatory" BOOLEAN NOT NULL DEFAULT true,
    "compliance" "TorCompliance" NOT NULL DEFAULT 'unanswered',
    "response" TEXT NOT NULL DEFAULT '',
    "reference" TEXT NOT NULL DEFAULT '',
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "solution_tor_clauses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "solution_tors_solutionId_key" ON "solution_tors"("solutionId");

-- CreateIndex
CREATE INDEX "solution_tor_files_solutionId_idx" ON "solution_tor_files"("solutionId");

-- CreateIndex
CREATE INDEX "solution_tor_clauses_solutionId_idx" ON "solution_tor_clauses"("solutionId");

-- AddForeignKey
ALTER TABLE "solution_tors" ADD CONSTRAINT "solution_tors_solutionId_fkey" FOREIGN KEY ("solutionId") REFERENCES "solutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "solution_tor_files" ADD CONSTRAINT "solution_tor_files_solutionId_fkey" FOREIGN KEY ("solutionId") REFERENCES "solutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "solution_tor_clauses" ADD CONSTRAINT "solution_tor_clauses_solutionId_fkey" FOREIGN KEY ("solutionId") REFERENCES "solutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

