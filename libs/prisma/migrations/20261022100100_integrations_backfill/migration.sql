-- ระบบภายนอก 1 ระบบต่อ key เดิม 1 ใบ — key ทุกใบทำงานเหมือนเดิมทุกประการ:
-- ทั้งสองโหมด และ X-Acting-User เปิด (key ใหม่หลังจากนี้ปิดเป็นค่าเริ่มต้น).
-- id ของ integration = id ของ key จึงรันซ้ำได้โดยไม่สร้างซ้ำ.
INSERT INTO "integrations" ("id", "companyId", "name", "modes", "allowActingUser", "active", "createdBy", "createdAt", "updatedAt")
SELECT k."id", k."companyId", k."name", ARRAY['app', 'delegated']::TEXT[], true,
       k."active" AND k."revokedAt" IS NULL, k."createdBy", k."createdAt", CURRENT_TIMESTAMP
FROM "api_keys" k
WHERE k."integrationId" IS NULL
ON CONFLICT ("id") DO NOTHING;

UPDATE "api_keys" SET "integrationId" = "id" WHERE "integrationId" IS NULL;

-- ย้อนกลับ (ถ้าต้องการ):
--   UPDATE "api_keys" SET "integrationId" = NULL WHERE "integrationId" = "id";
--   DELETE FROM "integrations" i WHERE EXISTS (SELECT 1 FROM "api_keys" k WHERE k."id" = i."id");
