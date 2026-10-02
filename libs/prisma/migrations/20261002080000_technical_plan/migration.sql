-- AlterTable
ALTER TABLE "project_tasks" ADD COLUMN     "crewUserIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "needsEquipment" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "project_task_equipment" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "boqIndex" INTEGER,
    "name" TEXT NOT NULL,
    "quantity" DECIMAL(12,2) NOT NULL,
    "unit" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "project_task_equipment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_task_equipment_projectId_idx" ON "project_task_equipment"("projectId");

-- CreateIndex
CREATE INDEX "project_task_equipment_taskId_idx" ON "project_task_equipment"("taskId");

-- AddForeignKey
ALTER TABLE "project_task_equipment" ADD CONSTRAINT "project_task_equipment_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "project_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

