-- CD-66 คำขอจากลูกค้า — ช่องทางรับคำขอ (web form / LINE / AI CARE) และผู้ติดต่อบนคำขอ

-- CreateEnum
CREATE TYPE "IntakeChannel" AS ENUM ('web_form', 'line', 'ai_care');

-- AlterTable
ALTER TABLE "requests" ADD COLUMN     "channel" "IntakeChannel",
ADD COLUMN     "contactCompany" TEXT,
ADD COLUMN     "contactEmail" TEXT,
ADD COLUMN     "contactName" TEXT,
ADD COLUMN     "contactPhone" TEXT,
ADD COLUMN     "contactTaxId" TEXT,
ADD COLUMN     "contactLineUserId" TEXT,
ADD COLUMN     "statusTokenHash" TEXT;

-- CreateTable
CREATE TABLE "request_intake_channels" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "channel" "IntakeChannel" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "requesterUserId" TEXT NOT NULL,
    "typeCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "slug" TEXT,
    "title" TEXT,
    "intro" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "request_intake_channels_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "request_intake_channels_slug_key" ON "request_intake_channels"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "request_intake_channels_companyId_channel_key" ON "request_intake_channels"("companyId", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "requests_statusTokenHash_key" ON "requests"("statusTokenHash");

-- AddForeignKey
ALTER TABLE "request_intake_channels" ADD CONSTRAINT "request_intake_channels_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "request_intake_channels" ADD CONSTRAINT "request_intake_channels_requesterUserId_fkey" FOREIGN KEY ("requesterUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

