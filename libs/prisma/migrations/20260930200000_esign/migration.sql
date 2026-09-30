-- CD-14 ระบบลงนามอิเล็กทรอนิกส์ (CD-165..170, CD-173)
-- CreateTable
CREATE TABLE "esign_layouts" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "docType" TEXT NOT NULL DEFAULT 'contract',
    "fields" JSONB NOT NULL DEFAULT '[]',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "esign_layouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "esign_envelopes" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "layoutId" TEXT,
    "fields" JSONB NOT NULL DEFAULT '[]',
    "mode" TEXT NOT NULL DEFAULT 'sequential',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "message" TEXT,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "refType" TEXT NOT NULL,
    "refId" TEXT NOT NULL,
    "originalKey" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "originalHash" TEXT NOT NULL,
    "signedKey" TEXT,
    "signedHash" TEXT,
    "verifyCode" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,

    CONSTRAINT "esign_envelopes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "esign_signers" (
    "id" TEXT NOT NULL,
    "envelopeId" TEXT NOT NULL,
    "fieldKey" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "userId" TEXT,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "tokenHash" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "tokenUsedAt" TIMESTAMP(3),
    "otpHash" TEXT,
    "otpChannel" TEXT,
    "otpSentAt" TIMESTAMP(3),
    "otpExpiresAt" TIMESTAMP(3),
    "otpAttempts" INTEGER NOT NULL DEFAULT 0,
    "otpVerifiedAt" TIMESTAMP(3),
    "viewedAt" TIMESTAMP(3),
    "signedAt" TIMESTAMP(3),
    "signatureKind" TEXT,
    "signatureKey" TEXT,
    "signatureText" TEXT,
    "authMethod" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "declinedAt" TIMESTAMP(3),
    "declinedReason" TEXT,

    CONSTRAINT "esign_signers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "esign_events" (
    "id" TEXT NOT NULL,
    "envelopeId" TEXT NOT NULL,
    "signerId" TEXT,
    "type" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip" TEXT,
    "userAgent" TEXT,
    "detail" JSONB,

    CONSTRAINT "esign_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "esign_layouts_companyId_code_key" ON "esign_layouts"("companyId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "esign_envelopes_signedHash_key" ON "esign_envelopes"("signedHash");

-- CreateIndex
CREATE UNIQUE INDEX "esign_envelopes_verifyCode_key" ON "esign_envelopes"("verifyCode");

-- CreateIndex
CREATE INDEX "esign_envelopes_companyId_status_idx" ON "esign_envelopes"("companyId", "status");

-- CreateIndex
CREATE INDEX "esign_envelopes_refType_refId_idx" ON "esign_envelopes"("refType", "refId");

-- CreateIndex
CREATE UNIQUE INDEX "esign_signers_tokenHash_key" ON "esign_signers"("tokenHash");

-- CreateIndex
CREATE INDEX "esign_signers_userId_status_idx" ON "esign_signers"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "esign_signers_envelopeId_fieldKey_key" ON "esign_signers"("envelopeId", "fieldKey");

-- CreateIndex
CREATE INDEX "esign_events_envelopeId_at_idx" ON "esign_events"("envelopeId", "at");

-- AddForeignKey
ALTER TABLE "esign_signers" ADD CONSTRAINT "esign_signers_envelopeId_fkey" FOREIGN KEY ("envelopeId") REFERENCES "esign_envelopes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "esign_events" ADD CONSTRAINT "esign_events_envelopeId_fkey" FOREIGN KEY ("envelopeId") REFERENCES "esign_envelopes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "esign_events" ADD CONSTRAINT "esign_events_signerId_fkey" FOREIGN KEY ("signerId") REFERENCES "esign_signers"("id") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE "esign_envelopes"
  ADD CONSTRAINT "esign_envelopes_status_check"
    CHECK ("status" IN ('draft', 'sent', 'completed', 'declined', 'cancelled', 'expired')),
  ADD CONSTRAINT "esign_envelopes_mode_check"
    CHECK ("mode" IN ('sequential', 'parallel'));
ALTER TABLE "esign_signers"
  ADD CONSTRAINT "esign_signers_status_check"
    CHECK ("status" IN ('pending', 'signed', 'declined')),
  ADD CONSTRAINT "esign_signers_kind_check"
    CHECK ("kind" IN ('internal', 'external')),
  ADD CONSTRAINT "esign_signers_party_check"
    CHECK (("kind" = 'internal' AND "userId" IS NOT NULL)
        OR ("kind" = 'external' AND ("email" IS NOT NULL OR "phone" IS NOT NULL)));
