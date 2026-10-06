-- CD-270 (CD-15 MACOM) — events: details on the campaign + registrations.
-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN     "eventCapacity" INTEGER,
ADD COLUMN     "eventEndsAt" TIMESTAMP(3),
ADD COLUMN     "eventOnlineUrl" TEXT,
ADD COLUMN     "eventStartsAt" TIMESTAMP(3),
ADD COLUMN     "eventVenue" TEXT,
ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'campaign';

-- CreateTable
CREATE TABLE "campaign_registrations" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "company" TEXT,
    "contactName" TEXT NOT NULL,
    "position" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "need" TEXT,
    "consentAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'registered',
    "walkIn" BOOLEAN NOT NULL DEFAULT false,
    "attendedAt" TIMESTAMP(3),
    "attendedBy" TEXT,
    "interest" TEXT,
    "followNote" TEXT,
    "leadId" TEXT,
    "leadOutcome" TEXT,
    "convertedAt" TIMESTAMP(3),
    "convertedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "campaign_registrations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "campaign_registrations_campaignId_status_idx" ON "campaign_registrations"("campaignId", "status");

-- AddForeignKey
ALTER TABLE "campaign_registrations" ADD CONSTRAINT "campaign_registrations_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

