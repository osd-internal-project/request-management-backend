-- CreateTable
CREATE TABLE "project_config_items" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "system" TEXT NOT NULL,
    "installationId" TEXT,
    "environmentId" TEXT,
    "key" TEXT NOT NULL,
    "value" TEXT,
    "isSecret" BOOLEAN NOT NULL DEFAULT false,
    "secretSealed" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "project_config_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_config_history" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "oldValue" TEXT,
    "newValue" TEXT,
    "oldSealed" TEXT,
    "newSealed" TEXT,
    "reason" TEXT,
    "actorId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_config_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_config_items_companyId_key_idx" ON "project_config_items"("companyId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "project_config_items_projectId_seq_key" ON "project_config_items"("projectId", "seq");

-- CreateIndex
CREATE INDEX "project_config_history_itemId_at_idx" ON "project_config_history"("itemId", "at");

-- AddForeignKey
ALTER TABLE "project_config_items" ADD CONSTRAINT "project_config_items_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_config_history" ADD CONSTRAINT "project_config_history_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "project_config_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

