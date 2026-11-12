-- legal.contract.read now reaches ordinary contracts the way any owned row is
-- reached (owner, author, a granted person, a led/level/granted unit — Q9).
-- Reading every ordinary contract moves to legal.contract.read.all. Every role
-- holding the old code gets the new one, so nobody sees less on the day this
-- ships; an admin then removes it where it does not belong. Data only; re-running
-- it changes nothing. Confidential contracts are unchanged.

INSERT INTO "permissions" ("code", "module", "type")
VALUES ('legal.contract.read.all', 'legal', 'human')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "role_permissions" ("roleId", "permissionCode")
SELECT rp."roleId", 'legal.contract.read.all'
FROM "role_permissions" rp
WHERE rp."permissionCode" = 'legal.contract.read'
ON CONFLICT ("roleId", "permissionCode") DO NOTHING;
