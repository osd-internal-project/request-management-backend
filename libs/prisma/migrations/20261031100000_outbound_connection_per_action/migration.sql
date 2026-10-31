-- At Vuvagent each job is its own agent with its own URL and key, so one row per company
-- per action replaces one row per company per vendor. Nothing is decrypted or deleted:
-- a vendor row keeps its id for its first action, and any further action it carried is
-- copied to a new row with the same URL and sealed key. `endpoints` stays until labs
-- confirms; a later migration drops it.

-- DropIndex
DROP INDEX "outbound_connections_companyId_vendor_key";

-- AlterTable
ALTER TABLE "outbound_connections" ADD COLUMN     "action" TEXT,
ADD COLUMN     "endpointId" TEXT,
ADD COLUMN     "timeoutMinutes" INTEGER;

UPDATE "outbound_connections" c
SET "action" = first."key",
    "endpointId" = first."value"->>'endpointId',
    "timeoutMinutes" = (first."value"->>'timeoutMinutes')::int
FROM (
  SELECT DISTINCT ON (o."id") o."id", e."key", e."value"
  FROM "outbound_connections" o, jsonb_each(o."endpoints") e
  ORDER BY o."id", e."key"
) first
WHERE c."id" = first."id";

INSERT INTO "outbound_connections"
  ("id", "companyId", "integrationId", "vendor", "action", "baseUrl", "secretEnc",
   "endpointId", "timeoutMinutes", "endpoints", "active", "createdBy", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, c."companyId", c."integrationId", c."vendor", e."key",
       c."baseUrl", c."secretEnc", e."value"->>'endpointId', (e."value"->>'timeoutMinutes')::int,
       '{}', c."active", c."createdBy", c."createdAt", CURRENT_TIMESTAMP
FROM "outbound_connections" c, jsonb_each(c."endpoints") e
WHERE c."action" IS NOT NULL AND e."key" <> c."action";

-- CreateIndex
CREATE UNIQUE INDEX "outbound_connections_companyId_action_key" ON "outbound_connections"("companyId", "action");
