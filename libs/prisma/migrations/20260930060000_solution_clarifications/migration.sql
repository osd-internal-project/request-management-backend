-- CreateTable
CREATE TABLE "solution_clarifications" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "solutionId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "question" TEXT NOT NULL,
    "askedOn" DATE NOT NULL,
    "askedBy" TEXT NOT NULL,
    "answer" TEXT,
    "respondent" TEXT,
    "answeredOn" DATE,
    "answerRecordedBy" TEXT,
    "answerRecordedAt" TIMESTAMP(3),
    "answeredOnVersionNo" INTEGER,
    "affectsScope" BOOLEAN NOT NULL DEFAULT false,
    "scopeResolvedVersionNo" INTEGER,
    "scopeResolvedAt" TIMESTAMP(3),
    "scopeResolvedBy" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "solution_clarifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "solution_clarifications_solutionId_idx" ON "solution_clarifications"("solutionId");

-- AddForeignKey
ALTER TABLE "solution_clarifications" ADD CONSTRAINT "solution_clarifications_solutionId_fkey" FOREIGN KEY ("solutionId") REFERENCES "solutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

