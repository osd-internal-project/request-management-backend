-- CD-229: the employee register — HR's facts per person × company, and skills.
-- CreateTable
CREATE TABLE "hr_employees" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "levelId" TEXT,
    "employmentType" TEXT NOT NULL DEFAULT 'permanent',
    "status" TEXT NOT NULL DEFAULT 'active',
    "endDate" DATE,
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "hr_employees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr_skills" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT '',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hr_skills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr_user_skills" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "proficiency" INTEGER NOT NULL,
    "certificate" TEXT NOT NULL DEFAULT '',
    "certExpiresOn" DATE,
    "note" TEXT NOT NULL DEFAULT '',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "hr_user_skills_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "hr_employees_companyId_levelId_idx" ON "hr_employees"("companyId", "levelId");

-- CreateIndex
CREATE UNIQUE INDEX "hr_employees_companyId_userId_key" ON "hr_employees"("companyId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "hr_skills_code_key" ON "hr_skills"("code");

-- CreateIndex
CREATE INDEX "hr_user_skills_skillId_idx" ON "hr_user_skills"("skillId");

-- CreateIndex
CREATE UNIQUE INDEX "hr_user_skills_userId_skillId_key" ON "hr_user_skills"("userId", "skillId");

-- AddForeignKey
ALTER TABLE "hr_employees" ADD CONSTRAINT "hr_employees_levelId_fkey" FOREIGN KEY ("levelId") REFERENCES "hr_levels"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hr_user_skills" ADD CONSTRAINT "hr_user_skills_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "hr_skills"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

