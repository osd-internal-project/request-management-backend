-- CreateEnum
CREATE TYPE "PhoneReservationStatus" AS ENUM ('reserved', 'released', 'expired');

-- CreateTable
CREATE TABLE "opportunity_phone_reservations" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "fee" DECIMAL(14,2),
    "externalReservationId" TEXT NOT NULL,
    "status" "PhoneReservationStatus" NOT NULL DEFAULT 'reserved',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "expiryWarnedFor" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "releasedBy" TEXT,
    "releaseReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "opportunity_phone_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "opportunity_phone_reservations_opportunityId_idx" ON "opportunity_phone_reservations"("opportunityId");

-- CreateIndex
CREATE INDEX "opportunity_phone_reservations_status_expiresAt_idx" ON "opportunity_phone_reservations"("status", "expiresAt");

-- AddForeignKey
ALTER TABLE "opportunity_phone_reservations" ADD CONSTRAINT "opportunity_phone_reservations_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "opportunities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- CD-78: one live hold per number per company — a second reserve of the same
-- number (a retry, two tabs) fails here even if Reserve-phone answered twice.
CREATE UNIQUE INDEX "opportunity_phone_reservations_live_number_key" ON "opportunity_phone_reservations"("companyId", "number") WHERE "status" = 'reserved';
