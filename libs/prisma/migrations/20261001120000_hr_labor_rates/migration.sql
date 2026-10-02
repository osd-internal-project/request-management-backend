-- CD-207 (part of CD-17 HR): levels, work types and cost per manday — the one source of labour cost.
-- CreateTable
CREATE TABLE "hr_levels" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hr_levels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr_work_types" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hr_work_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr_labor_rates" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "levelId" TEXT NOT NULL,
    "workTypeId" TEXT NOT NULL,
    "costPerManday" DECIMAL(14,2) NOT NULL,
    "sellPerManday" DECIMAL(14,2),
    "validFrom" DATE NOT NULL,
    "validTo" DATE,
    "note" TEXT NOT NULL DEFAULT '',
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "hr_labor_rates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "hr_levels_companyId_code_key" ON "hr_levels"("companyId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "hr_work_types_companyId_code_key" ON "hr_work_types"("companyId", "code");

-- CreateIndex
CREATE INDEX "hr_labor_rates_companyId_levelId_workTypeId_validFrom_idx" ON "hr_labor_rates"("companyId", "levelId", "workTypeId", "validFrom");

-- AddForeignKey
ALTER TABLE "hr_labor_rates" ADD CONSTRAINT "hr_labor_rates_levelId_fkey" FOREIGN KEY ("levelId") REFERENCES "hr_levels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hr_labor_rates" ADD CONSTRAINT "hr_labor_rates_workTypeId_fkey" FOREIGN KEY ("workTypeId") REFERENCES "hr_work_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

