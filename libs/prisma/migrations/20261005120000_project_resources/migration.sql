-- AlterTable
ALTER TABLE "crm_company_configs" ADD COLUMN     "projectResourceTypeCode" TEXT;

-- CreateTable
CREATE TABLE "project_booking_priorities" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "priority" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "conflictProjectIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "overbookedDays" INTEGER NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_booking_priorities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_resource_requests" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "role" TEXT NOT NULL,
    "skillId" TEXT,
    "headcount" INTEGER NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "hoursPerDay" DECIMAL(3,1) NOT NULL,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "requestId" TEXT,
    "error" TEXT,
    "submittedAt" TIMESTAMP(3),
    "submittedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "fulfilledAt" TIMESTAMP(3),
    "fulfilledBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_resource_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "project_booking_priorities_bookingId_key" ON "project_booking_priorities"("bookingId");

-- CreateIndex
CREATE INDEX "project_booking_priorities_projectId_idx" ON "project_booking_priorities"("projectId");

-- CreateIndex
CREATE INDEX "project_resource_requests_requestId_idx" ON "project_resource_requests"("requestId");

-- CreateIndex
CREATE UNIQUE INDEX "project_resource_requests_projectId_seq_key" ON "project_resource_requests"("projectId", "seq");

-- AddForeignKey
ALTER TABLE "project_booking_priorities" ADD CONSTRAINT "project_booking_priorities_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_resource_requests" ADD CONSTRAINT "project_resource_requests_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

