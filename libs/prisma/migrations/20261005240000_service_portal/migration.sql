-- AlterTable
ALTER TABLE "crm_company_configs" ADD COLUMN     "servicePortalUserId" TEXT;

-- CreateTable
CREATE TABLE "service_portal_contacts" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "inviteHash" TEXT,
    "inviteExpires" TIMESTAMP(3),
    "invitedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "invitedBy" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedBy" TEXT,

    CONSTRAINT "service_portal_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_portal_sessions" (
    "id" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_portal_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "service_portal_contacts_inviteHash_key" ON "service_portal_contacts"("inviteHash");

-- CreateIndex
CREATE INDEX "service_portal_contacts_companyId_customerId_idx" ON "service_portal_contacts"("companyId", "customerId");

-- CreateIndex
CREATE UNIQUE INDEX "service_portal_sessions_tokenHash_key" ON "service_portal_sessions"("tokenHash");

-- CreateIndex
CREATE INDEX "service_portal_sessions_contactId_idx" ON "service_portal_sessions"("contactId");

