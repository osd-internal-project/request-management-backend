-- P3 / Q9 — Care conversations are seen like any owned row: the agent holding
-- one, a person granted to them, the agent's current unit inside what the
-- viewer leads, reaches by role level or was granted. Chats waiting for a
-- person stay visible to everyone who may take them (service.care.manage).
-- Reading every conversation is the new service.care.read.all, granted here to
-- every role holding service.care.manage so nobody sees less on day one.
-- Additive: one index, one nullable foreign key (0 conversations on the live DB
-- on 12 Nov 2026), two INSERTs that re-running changes nothing.

CREATE INDEX "care_conversations_agentUserId_idx" ON "care_conversations"("agentUserId");

ALTER TABLE "care_conversations" ADD CONSTRAINT "care_conversations_agentUserId_fkey" FOREIGN KEY ("agentUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

INSERT INTO "permissions" ("code", "module", "type")
VALUES ('service.care.read.all', 'service', 'human')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "role_permissions" ("roleId", "permissionCode")
SELECT rp."roleId", 'service.care.read.all'
FROM "role_permissions" rp
WHERE rp."permissionCode" = 'service.care.manage'
ON CONFLICT ("roleId", "permissionCode") DO NOTHING;
