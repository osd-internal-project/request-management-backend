-- CreateEnum
CREATE TYPE "SolutionVersionStatus" AS ENUM ('draft', 'locked', 'superseded');

-- CreateTable
CREATE TABLE "solutions" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "currentVersionNo" INTEGER NOT NULL DEFAULT 1,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "solutions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "solution_versions" (
    "id" TEXT NOT NULL,
    "solutionId" TEXT NOT NULL,
    "versionNo" INTEGER NOT NULL,
    "status" "SolutionVersionStatus" NOT NULL DEFAULT 'draft',
    "summary" TEXT NOT NULL DEFAULT '',
    "design" TEXT NOT NULL DEFAULT '',
    "assumptions" JSONB NOT NULL DEFAULT '[]',
    "changeNote" TEXT,
    "lockedAt" TIMESTAMP(3),
    "lockedBy" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "solution_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "solution_files" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "uploadedBy" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "solution_files_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "solutions_requestId_key" ON "solutions"("requestId");

-- CreateIndex
CREATE INDEX "solutions_companyId_opportunityId_idx" ON "solutions"("companyId", "opportunityId");

-- CreateIndex
CREATE UNIQUE INDEX "solution_versions_solutionId_versionNo_key" ON "solution_versions"("solutionId", "versionNo");

-- CreateIndex
CREATE INDEX "solution_files_versionId_idx" ON "solution_files"("versionId");

-- AddForeignKey
ALTER TABLE "solutions" ADD CONSTRAINT "solutions_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "opportunities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "solution_versions" ADD CONSTRAINT "solution_versions_solutionId_fkey" FOREIGN KEY ("solutionId") REFERENCES "solutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "solution_files" ADD CONSTRAINT "solution_files_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "solution_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

