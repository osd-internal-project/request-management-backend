-- AlterTable
ALTER TABLE "crm_company_configs" ADD COLUMN     "projectReadinessChecklist" TEXT[] DEFAULT ARRAY['หน้างานสะอาดเรียบร้อย', 'ติดป้ายและฉลากอุปกรณ์ครบ', 'อบรมผู้ใช้งานแล้ว', 'สำรองค่าตั้งค่าระบบแล้ว']::TEXT[];

-- CreateTable
CREATE TABLE "project_readiness_items" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "inspectorUserId" TEXT,
    "result" TEXT,
    "checkedOn" DATE,
    "note" TEXT,
    "checkedBy" TEXT,
    "checkedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "project_readiness_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_readiness_items_inspectorUserId_result_idx" ON "project_readiness_items"("inspectorUserId", "result");

-- CreateIndex
CREATE UNIQUE INDEX "project_readiness_items_projectId_seq_key" ON "project_readiness_items"("projectId", "seq");

-- AddForeignKey
ALTER TABLE "project_readiness_items" ADD CONSTRAINT "project_readiness_items_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

