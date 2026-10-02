-- AlterTable
ALTER TABLE "project_installations" ADD COLUMN     "taskId" TEXT;

-- AlterTable
ALTER TABLE "project_test_items" ADD COLUMN     "taskId" TEXT;

-- CreateIndex
CREATE INDEX "project_installations_taskId_idx" ON "project_installations"("taskId");

-- CreateIndex
CREATE INDEX "project_test_items_taskId_idx" ON "project_test_items"("taskId");

