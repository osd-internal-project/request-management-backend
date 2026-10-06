-- CD-269 (CD-15 MACOM) — campaign public lead form + Lead Ads form ids.
-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN     "adFormIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "formEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "formIntro" TEXT,
ADD COLUMN     "formToken" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "campaigns_formToken_key" ON "campaigns"("formToken");

