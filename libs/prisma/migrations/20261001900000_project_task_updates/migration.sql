-- AlterTable
ALTER TABLE "project_tasks" ADD COLUMN     "doneAt" TIMESTAMP(3),
ADD COLUMN     "doneBy" TEXT,
ADD COLUMN     "startedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "project_task_updates" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "statusFrom" TEXT,
    "statusTo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_task_updates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_task_files" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "updateId" TEXT,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "uploadedBy" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "project_task_files_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_task_updates_taskId_createdAt_idx" ON "project_task_updates"("taskId", "createdAt");

-- CreateIndex
CREATE INDEX "project_task_files_taskId_idx" ON "project_task_files"("taskId");

-- AddForeignKey
ALTER TABLE "project_task_updates" ADD CONSTRAINT "project_task_updates_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "project_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_task_files" ADD CONSTRAINT "project_task_files_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "project_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_task_files" ADD CONSTRAINT "project_task_files_updateId_fkey" FOREIGN KEY ("updateId") REFERENCES "project_task_updates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

