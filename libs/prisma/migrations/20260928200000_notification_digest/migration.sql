-- AlterTable
ALTER TABLE "notification_preferences" ADD COLUMN     "categorySettings" JSONB,
ADD COLUMN     "digestHour" INTEGER NOT NULL DEFAULT 8,
ADD COLUMN     "lastDigestDate" TEXT;

-- AlterTable
ALTER TABLE "notifications" ADD COLUMN     "digestId" TEXT,
ADD COLUMN     "heldForDigest" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "notifications_heldForDigest_digestId_idx" ON "notifications"("heldForDigest", "digestId");

