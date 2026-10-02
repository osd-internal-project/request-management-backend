-- CD-204: a line quoted below the system price keeps that price, the reason and who did it.
ALTER TABLE "quotation_lines" ADD COLUMN "systemPrice" DECIMAL(14,2),
ADD COLUMN "overrideReason" TEXT,
ADD COLUMN "overriddenBy" TEXT;
