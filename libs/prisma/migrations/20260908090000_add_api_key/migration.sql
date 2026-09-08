-- AUTH-06 (8 ก.ย. 2569): a credential an integration can hold without
-- refreshing it.
--
-- The chatbot had to fetch a Keycloak client-credentials token before every
-- burst of calls and hold the client secret to do it. This table replaces that
-- with one key per integration: core-service exchanges it for a real token
-- internally, so nothing downstream — and no second token verifier — changes.
--
-- `expiresAt` NULL is the point of the table: a key that does not expire. What
-- makes that safe is that it can be taken away, which a long-lived token
-- cannot: set `active` false or `revokedAt`, and the next resolution refuses it
-- (within the 60-second principal cache).
--
-- Only `keyHash` is stored. There is no column holding a usable key, so this
-- table leaking does not leak a credential.

-- CreateTable
CREATE TABLE "api_keys" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "expiresAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedBy" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_prefix_key" ON "api_keys"("prefix");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_keyHash_key" ON "api_keys"("keyHash");

-- CreateIndex
CREATE INDEX "api_keys_active_idx" ON "api_keys"("active");
