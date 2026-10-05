-- CreateTable
CREATE TABLE "acceptance_certificates" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "acceptanceId" TEXT NOT NULL,
    "milestoneId" TEXT,
    "certificateNo" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "source" TEXT NOT NULL DEFAULT 'esign',
    "draftKey" TEXT,
    "envelopeId" TEXT,
    "signedKey" TEXT,
    "signedName" TEXT,
    "signedSize" INTEGER,
    "signedAt" TIMESTAMP(3),
    "paperReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "acceptance_certificates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "acceptance_certificates_acceptanceId_key" ON "acceptance_certificates"("acceptanceId");

-- CreateIndex
CREATE UNIQUE INDEX "acceptance_certificates_envelopeId_key" ON "acceptance_certificates"("envelopeId");

-- CreateIndex
CREATE INDEX "acceptance_certificates_projectId_idx" ON "acceptance_certificates"("projectId");

