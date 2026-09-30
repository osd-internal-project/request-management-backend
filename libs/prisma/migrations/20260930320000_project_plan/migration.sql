-- CreateTable
CREATE TABLE "project_tasks" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "parentId" TEXT,
    "seq" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "ownerUserId" TEXT,
    "durationDays" INTEGER NOT NULL DEFAULT 1,
    "milestoneId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "project_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_task_links" (
    "predecessorId" TEXT NOT NULL,
    "successorId" TEXT NOT NULL,
    "lagDays" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_task_links_pkey" PRIMARY KEY ("predecessorId","successorId")
);

-- CreateIndex
CREATE INDEX "project_tasks_projectId_parentId_seq_idx" ON "project_tasks"("projectId", "parentId", "seq");

-- CreateIndex
CREATE INDEX "project_task_links_successorId_idx" ON "project_task_links"("successorId");

-- AddForeignKey
ALTER TABLE "project_tasks" ADD CONSTRAINT "project_tasks_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_tasks" ADD CONSTRAINT "project_tasks_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "project_tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_tasks" ADD CONSTRAINT "project_tasks_milestoneId_fkey" FOREIGN KEY ("milestoneId") REFERENCES "project_milestones"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_task_links" ADD CONSTRAINT "project_task_links_predecessorId_fkey" FOREIGN KEY ("predecessorId") REFERENCES "project_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_task_links" ADD CONSTRAINT "project_task_links_successorId_fkey" FOREIGN KEY ("successorId") REFERENCES "project_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- a task is not its own predecessor
ALTER TABLE "project_task_links" ADD CONSTRAINT "project_task_links_not_self" CHECK ("predecessorId" <> "successorId");
