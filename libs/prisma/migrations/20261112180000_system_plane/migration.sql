-- CreateEnum
CREATE TYPE "RoleLevel" AS ENUM ('COMPANY', 'SYSTEM');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "suspendReason" TEXT,
ADD COLUMN     "suspendedAt" TIMESTAMP(3),
ADD COLUMN     "suspendedBy" TEXT;

-- AlterTable
ALTER TABLE "roles" ADD COLUMN     "level" "RoleLevel" NOT NULL DEFAULT 'COMPANY';

-- AlterTable
ALTER TABLE "hr_skills" ADD COLUMN     "companyId" TEXT;

-- CreateTable
CREATE TABLE "system_user_roles" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "grantedByUserId" TEXT,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "system_user_roles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "system_user_roles_userId_roleId_key" ON "system_user_roles"("userId", "roleId");

-- CreateIndex
CREATE INDEX "hr_skills_companyId_idx" ON "hr_skills"("companyId");

-- AddForeignKey
ALTER TABLE "system_user_roles" ADD CONSTRAINT "system_user_roles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "system_user_roles" ADD CONSTRAINT "system_user_roles_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hr_skills" ADD CONSTRAINT "hr_skills_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- role ระดับระบบต้องไม่ผูกบริษัท
ALTER TABLE "roles" ADD CONSTRAINT "roles_system_has_no_company" CHECK ("level" <> 'SYSTEM' OR "companyId" IS NULL);
