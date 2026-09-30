-- CD-172 ทะเบียนผู้มีอำนาจลงนาม
-- AlterTable
ALTER TABLE "esign_envelopes" ADD COLUMN     "amount" DECIMAL(14,2),
ADD COLUMN     "docType" TEXT NOT NULL DEFAULT 'contract';

-- CreateTable
CREATE TABLE "esign_authorities" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "limitAmount" DECIMAL(14,2),
    "docTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "validFrom" DATE,
    "validTo" DATE,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "esign_authorities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "esign_authorities_companyId_userId_idx" ON "esign_authorities"("companyId", "userId");


ALTER TABLE "esign_authorities"
  ADD CONSTRAINT "esign_authorities_limit_check"
    CHECK ("limitAmount" IS NULL OR "limitAmount" > 0),
  ADD CONSTRAINT "esign_authorities_period_check"
    CHECK ("validFrom" IS NULL OR "validTo" IS NULL OR "validFrom" <= "validTo");
