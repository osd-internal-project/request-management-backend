-- CreateTable
CREATE TABLE "project_risks" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'project',
    "sourceRef" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "likelihood" INTEGER NOT NULL,
    "impact" INTEGER NOT NULL,
    "ownerUserId" TEXT,
    "response" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "reviewEveryDays" INTEGER NOT NULL DEFAULT 14,
    "lastReviewedAt" TIMESTAMP(3),
    "nextReviewOn" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "project_risks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_risk_reviews" (
    "id" TEXT NOT NULL,
    "riskId" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "likelihood" INTEGER NOT NULL,
    "impact" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "reviewedBy" TEXT NOT NULL,
    "reviewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_risk_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_risks_companyId_status_idx" ON "project_risks"("companyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "project_risks_projectId_seq_key" ON "project_risks"("projectId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "project_risks_projectId_sourceRef_key" ON "project_risks"("projectId", "sourceRef");

-- CreateIndex
CREATE INDEX "project_risk_reviews_riskId_reviewedAt_idx" ON "project_risk_reviews"("riskId", "reviewedAt");

-- AddForeignKey
ALTER TABLE "project_risks" ADD CONSTRAINT "project_risks_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_risk_reviews" ADD CONSTRAINT "project_risk_reviews_riskId_fkey" FOREIGN KEY ("riskId") REFERENCES "project_risks"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- scored 1–5 × 1–5, like CD-141
ALTER TABLE "project_risks" ADD CONSTRAINT "project_risks_score" CHECK ("likelihood" BETWEEN 1 AND 5 AND "impact" BETWEEN 1 AND 5);
