-- CreateTable
CREATE TABLE "project_installations" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "location" TEXT NOT NULL,
    "boqIndex" INTEGER,
    "serialNo" TEXT,
    "note" TEXT,
    "installedOn" DATE,
    "installedBy" TEXT,
    "beforeKey" TEXT,
    "beforeName" TEXT,
    "beforeMime" TEXT,
    "afterKey" TEXT,
    "afterName" TEXT,
    "afterMime" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "project_installations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_installations_projectId_boqIndex_idx" ON "project_installations"("projectId", "boqIndex");

-- CreateIndex
CREATE UNIQUE INDEX "project_installations_projectId_seq_key" ON "project_installations"("projectId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "project_installations_projectId_serialNo_key" ON "project_installations"("projectId", "serialNo");

-- AddForeignKey
ALTER TABLE "project_installations" ADD CONSTRAINT "project_installations_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

