-- CreateEnum
CREATE TYPE "RequirementKind" AS ENUM ('business', 'technical');

-- CreateEnum
CREATE TYPE "RequirementAssessment" AS ENUM ('unassessed', 'feasible', 'not_feasible', 'needs_info');

-- CreateTable
CREATE TABLE "solution_requirements" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "solutionId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" "RequirementKind" NOT NULL,
    "text" TEXT NOT NULL,
    "assessment" "RequirementAssessment" NOT NULL DEFAULT 'unassessed',
    "note" TEXT NOT NULL DEFAULT '',
    "customerAnswer" TEXT,
    "answeredAt" TIMESTAMP(3),
    "answeredBy" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "solution_requirements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "solution_requirements_solutionId_idx" ON "solution_requirements"("solutionId");

-- AddForeignKey
ALTER TABLE "solution_requirements" ADD CONSTRAINT "solution_requirements_solutionId_fkey" FOREIGN KEY ("solutionId") REFERENCES "solutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

