-- AlterTable
ALTER TABLE "api_keys" ADD COLUMN     "integrationId" TEXT;

-- AlterTable
ALTER TABLE "webhook_subscriptions" ADD COLUMN     "integrationId" TEXT;

-- CreateTable
CREATE TABLE "integrations" (
    "id" TEXT NOT NULL,
    "companyId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "modes" TEXT[] DEFAULT ARRAY['app', 'delegated']::TEXT[],
    "allowActingUser" BOOLEAN NOT NULL DEFAULT false,
    "keycloakClientIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integrations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "integrations_companyId_active_idx" ON "integrations"("companyId", "active");

-- CreateIndex
CREATE INDEX "api_keys_integrationId_idx" ON "api_keys"("integrationId");

-- CreateIndex
CREATE INDEX "webhook_subscriptions_integrationId_idx" ON "webhook_subscriptions"("integrationId");

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "integrations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_subscriptions" ADD CONSTRAINT "webhook_subscriptions_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "integrations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

