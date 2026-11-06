-- One outbound connection per company per vendor replaces one endpoint row per action.
-- Order matters: create, copy the existing rows across, then drop the old table.

-- AlterTable
ALTER TABLE "agent_records" ADD COLUMN     "timedOutAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "outbound_connections" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "vendor" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "secretEnc" TEXT NOT NULL,
    "endpoints" JSONB NOT NULL DEFAULT '{}',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "outbound_connections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "outbound_connections_integrationId_idx" ON "outbound_connections"("integrationId");

-- CreateIndex
CREATE UNIQUE INDEX "outbound_connections_companyId_vendor_key" ON "outbound_connections"("companyId", "vendor");

-- AddForeignKey
ALTER TABLE "outbound_connections" ADD CONSTRAINT "outbound_connections_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "integrations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Every action so far is Vuvagent's. The newest row of a company gives the URL and the
-- sealed key as they are (same CONFIG_SECRET_KEY, nothing decrypted); each action keeps
-- its endpoint id with the 30-minute default timeout.
INSERT INTO "outbound_connections"
  ("id", "companyId", "integrationId", "vendor", "baseUrl", "secretEnc", "endpoints", "active", "createdBy", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, latest."companyId", latest."integrationId", 'vuvagent',
       latest."baseUrl", latest."apiKeyEnc", grouped.endpoints, grouped.active,
       latest."createdBy", latest."createdAt", CURRENT_TIMESTAMP
FROM (
  SELECT DISTINCT ON ("companyId") *
  FROM "integration_endpoints"
  ORDER BY "companyId", "updatedAt" DESC
) latest
JOIN (
  SELECT "companyId",
         jsonb_object_agg("action", jsonb_build_object('endpointId', "endpointId", 'timeoutMinutes', 30)) AS endpoints,
         bool_or("active") AS active
  FROM "integration_endpoints"
  GROUP BY "companyId"
) grouped ON grouped."companyId" = latest."companyId";

-- DropForeignKey
ALTER TABLE "integration_endpoints" DROP CONSTRAINT "integration_endpoints_integrationId_fkey";

-- DropTable
DROP TABLE "integration_endpoints";
