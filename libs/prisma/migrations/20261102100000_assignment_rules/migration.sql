-- เส้นทาง Lead ถึงบริการ Phase 0 (2 พ.ย. 2569): ตารางทีม + ค่าต่อบทบาท + ประวัติการจัดคน.

-- CreateTable
CREATE TABLE "assignment_rules" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "orgUnitId" TEXT NOT NULL,
    "conditions" JSONB NOT NULL DEFAULT '{}',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assignment_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assignment_role_settings" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "fallbackUserId" TEXT,
    "loadTypeCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updatedBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assignment_role_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assignments" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "ruleId" TEXT,
    "orgUnitId" TEXT,
    "reason" TEXT NOT NULL,
    "criteria" JSONB NOT NULL DEFAULT '{}',
    "requestKey" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assignments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "assignment_rules_companyId_role_active_idx" ON "assignment_rules"("companyId", "role", "active");

-- CreateIndex
CREATE UNIQUE INDEX "assignment_role_settings_companyId_role_key" ON "assignment_role_settings"("companyId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "assignments_companyId_requestKey_key" ON "assignments"("companyId", "requestKey");

-- CreateIndex
CREATE INDEX "assignments_companyId_role_userId_createdAt_idx" ON "assignments"("companyId", "role", "userId", "createdAt");

-- CreateIndex
CREATE INDEX "assignments_companyId_resourceType_resourceId_idx" ON "assignments"("companyId", "resourceType", "resourceId");
