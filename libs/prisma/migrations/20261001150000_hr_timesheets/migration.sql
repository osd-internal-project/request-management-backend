-- CD-231: weekly timesheets — hours per day per piece of work, approved by the supervisor.
-- CreateTable
CREATE TABLE "hr_timesheets" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "weekStart" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "submittedAt" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3),
    "decidedBy" TEXT,
    "returnReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hr_timesheets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr_timesheet_lines" (
    "id" TEXT NOT NULL,
    "timesheetId" TEXT NOT NULL,
    "workDate" DATE NOT NULL,
    "kind" TEXT NOT NULL,
    "projectId" TEXT,
    "projectTaskId" TEXT,
    "requestId" TEXT,
    "solutionId" TEXT,
    "internalCode" TEXT,
    "workTypeId" TEXT NOT NULL,
    "hours" DECIMAL(4,1) NOT NULL,
    "billable" BOOLEAN NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "hr_timesheet_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr_internal_activities" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hr_internal_activities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "hr_timesheets_companyId_status_idx" ON "hr_timesheets"("companyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "hr_timesheets_companyId_userId_weekStart_key" ON "hr_timesheets"("companyId", "userId", "weekStart");

-- CreateIndex
CREATE INDEX "hr_timesheet_lines_timesheetId_workDate_idx" ON "hr_timesheet_lines"("timesheetId", "workDate");

-- CreateIndex
CREATE INDEX "hr_timesheet_lines_projectId_workDate_idx" ON "hr_timesheet_lines"("projectId", "workDate");

-- CreateIndex
CREATE UNIQUE INDEX "hr_internal_activities_code_key" ON "hr_internal_activities"("code");

-- AddForeignKey
ALTER TABLE "hr_timesheet_lines" ADD CONSTRAINT "hr_timesheet_lines_timesheetId_fkey" FOREIGN KEY ("timesheetId") REFERENCES "hr_timesheets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

