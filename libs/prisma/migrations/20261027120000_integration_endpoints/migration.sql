-- CreateTable
CREATE TABLE "integration_endpoints" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "apiKeyEnc" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integration_endpoints_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "integration_endpoints_integrationId_idx" ON "integration_endpoints"("integrationId");

-- CreateIndex
CREATE UNIQUE INDEX "integration_endpoints_companyId_action_key" ON "integration_endpoints"("companyId", "action");

-- AddForeignKey
ALTER TABLE "integration_endpoints" ADD CONSTRAINT "integration_endpoints_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "integrations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

