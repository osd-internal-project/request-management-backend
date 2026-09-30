-- CreateEnum
CREATE TYPE "SolutionRiskStatus" AS ENUM ('open', 'mitigated', 'accepted', 'closed');

-- CreateTable
CREATE TABLE "solution_risks" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "solutionId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "likelihood" INTEGER NOT NULL,
    "impact" INTEGER NOT NULL,
    "owner" TEXT NOT NULL DEFAULT '',
    "mitigation" TEXT NOT NULL DEFAULT '',
    "status" "SolutionRiskStatus" NOT NULL DEFAULT 'open',
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "solution_risks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "solution_risks_solutionId_idx" ON "solution_risks"("solutionId");

-- AddForeignKey
ALTER TABLE "solution_risks" ADD CONSTRAINT "solution_risks_solutionId_fkey" FOREIGN KEY ("solutionId") REFERENCES "solutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

