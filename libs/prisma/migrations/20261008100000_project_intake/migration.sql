-- CD-176 รับมอบงาน: the project manager receives the work from Sales and the
-- technical team line by line, or sends it back.
-- CreateEnum
CREATE TYPE "ProjectIntakeStatus" AS ENUM ('pending', 'returned', 'accepted');

-- AlterTable
ALTER TABLE "crm_company_configs" ADD COLUMN     "projectIntakeChecklist" TEXT[] DEFAULT ARRAY['ผู้ติดต่อฝั่งลูกค้าและช่องทางติดต่อชัดเจน', 'ทราบสถานที่และเงื่อนไขการเข้าหน้างาน']::TEXT[];

-- CreateTable
CREATE TABLE "project_intakes" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "status" "ProjectIntakeStatus" NOT NULL DEFAULT 'pending',
    "answers" JSONB NOT NULL DEFAULT '[]',
    "round" INTEGER NOT NULL DEFAULT 0,
    "history" JSONB NOT NULL DEFAULT '[]',
    "accepted" JSONB,
    "acceptedBy" TEXT,
    "acceptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "project_intakes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "project_intakes_projectId_key" ON "project_intakes"("projectId");

-- CreateIndex
CREATE INDEX "project_intakes_companyId_status_idx" ON "project_intakes"("companyId", "status");

-- AddForeignKey
ALTER TABLE "project_intakes" ADD CONSTRAINT "project_intakes_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Projects opened before this existed were taken on without it: recorded as
-- received when they opened, so nothing they already do is held back.
INSERT INTO "project_intakes" ("id", "companyId", "projectId", "status", "acceptedBy", "acceptedAt", "updatedAt")
SELECT gen_random_uuid()::text, p."companyId", p."id", 'accepted', p."openedBy", p."openedAt", CURRENT_TIMESTAMP
FROM "projects" p
WHERE NOT EXISTS (SELECT 1 FROM "project_intakes" i WHERE i."projectId" = p."id");
