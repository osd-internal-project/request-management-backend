-- CreateTable
CREATE TABLE "project_test_items" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "sourceRef" TEXT,
    "deliverable" TEXT,
    "text" TEXT NOT NULL,
    "steps" TEXT,
    "ownerUserId" TEXT,
    "waivedReason" TEXT,
    "waivedAt" TIMESTAMP(3),
    "waivedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "project_test_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_test_runs" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "note" TEXT,
    "evidenceKey" TEXT,
    "evidenceName" TEXT,
    "evidenceMime" TEXT,
    "evidenceSize" INTEGER,
    "issueId" TEXT,
    "testedBy" TEXT NOT NULL,
    "testedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_test_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "project_test_items_projectId_seq_key" ON "project_test_items"("projectId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "project_test_items_projectId_sourceRef_key" ON "project_test_items"("projectId", "sourceRef");

-- CreateIndex
CREATE INDEX "project_test_runs_itemId_testedAt_idx" ON "project_test_runs"("itemId", "testedAt");

-- AddForeignKey
ALTER TABLE "project_test_items" ADD CONSTRAINT "project_test_items_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_test_runs" ADD CONSTRAINT "project_test_runs_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "project_test_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

