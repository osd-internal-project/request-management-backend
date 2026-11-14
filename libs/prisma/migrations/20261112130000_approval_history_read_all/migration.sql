-- approval.history.read now reads only the cases the holder can open (SCOPE-02).
-- The whole-company view moves to approval.history.read.all. Every role that
-- holds the old code gets the new one too, so nobody sees less on the day this
-- ships; an admin then removes .read.all from the roles that should not have it.
-- Data only, no schema change; re-running it changes nothing.

INSERT INTO "permissions" ("code", "module", "type")
VALUES ('approval.history.read.all', 'approval', 'human')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "role_permissions" ("roleId", "permissionCode")
SELECT rp."roleId", 'approval.history.read.all'
FROM "role_permissions" rp
WHERE rp."permissionCode" = 'approval.history.read'
ON CONFLICT ("roleId", "permissionCode") DO NOTHING;
