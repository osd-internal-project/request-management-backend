-- Permission: the catalog row (user-service adds it at boot anyway) and a grant
-- to every role that already manages the softphone, so admins see the phone
-- workspace without a re-seed.
INSERT INTO "permissions" ("code", "module", "type")
VALUES ('phone.workspace.use', 'phone', 'human')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "role_permissions" ("roleId", "permissionCode")
SELECT rp."roleId", 'phone.workspace.use'
FROM "role_permissions" rp
WHERE rp."permissionCode" = 'admin.softphone.manage'
ON CONFLICT ("roleId", "permissionCode") DO NOTHING;
