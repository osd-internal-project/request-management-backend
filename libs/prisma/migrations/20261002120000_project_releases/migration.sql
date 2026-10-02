-- CreateTable
CREATE TABLE "project_environments" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "project_environments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_releases" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "project_releases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_deployments" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "releaseId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "deployedAt" TIMESTAMP(3) NOT NULL,
    "deployedBy" TEXT NOT NULL,
    "note" TEXT,
    "overrideReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_deployments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_environments_projectId_idx" ON "project_environments"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "project_releases_projectId_version_key" ON "project_releases"("projectId", "version");

-- CreateIndex
CREATE INDEX "project_deployments_environmentId_deployedAt_idx" ON "project_deployments"("environmentId", "deployedAt");

-- AddForeignKey
ALTER TABLE "project_environments" ADD CONSTRAINT "project_environments_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_releases" ADD CONSTRAINT "project_releases_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_deployments" ADD CONSTRAINT "project_deployments_releaseId_fkey" FOREIGN KEY ("releaseId") REFERENCES "project_releases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_deployments" ADD CONSTRAINT "project_deployments_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "project_environments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

