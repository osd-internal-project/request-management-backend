-- CD-227 ส่งมอบงานเทคนิคให้ทีมบริการ: the project team's cautions for the service team.
-- CreateTable
CREATE TABLE "project_service_briefs" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "cautions" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "project_service_briefs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "project_service_briefs_projectId_key" ON "project_service_briefs"("projectId");

-- AddForeignKey
ALTER TABLE "project_service_briefs" ADD CONSTRAINT "project_service_briefs_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

