-- CreateTable
CREATE TABLE "opportunity_activity_photos" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "activityId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "uploadedBy" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "opportunity_activity_photos_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "opportunity_activity_photos_activityId_idx" ON "opportunity_activity_photos"("activityId");

-- AddForeignKey
ALTER TABLE "opportunity_activity_photos" ADD CONSTRAINT "opportunity_activity_photos_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "opportunity_activities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

