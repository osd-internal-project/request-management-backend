-- crm.lead.* แยกออกจาก crm.sales.* (3 พ.ย. 2569, docs/permission-taxonomy.md).
-- ไม่มีใครเสียสิทธิ์: ทุก role / key ที่ถือตัวเดิมได้ตัวใหม่คู่กัน — crm.sales.* ยังอยู่และยังคุมดีล.

-- 1) key: scope ของเครื่องที่อ่าน Lead ทั้งบริษัทเปลี่ยนชื่อเป็น .read.all ก่อน
--    เพราะชื่อเดิม integration.crm.lead.read กลายเป็น twin ของ crm.lead.read (คน)
UPDATE "api_keys"
SET "scopes" = array_replace("scopes", 'integration.crm.lead.read', 'integration.crm.lead.read.all')
WHERE 'integration.crm.lead.read' = ANY("scopes");

-- 2) key ที่ทำงานในนามคนบน route Lead อยู่แล้ว (ผ่าน crm.sales.*) ได้ twin ใหม่
WITH map(old, new) AS (VALUES
  ('integration.crm.sales.read', 'integration.crm.lead.read'),
  ('integration.crm.sales.manage', 'integration.crm.lead.manage')
),
widened AS (
  SELECT k."id", array_agg(DISTINCT x ORDER BY x) AS scopes
  FROM "api_keys" k
  CROSS JOIN LATERAL (
    SELECT unnest(k."scopes")
    UNION
    SELECT m.new FROM map m WHERE m.old = ANY(k."scopes")
  ) AS u(x)
  WHERE k."scopes" && ARRAY(SELECT old FROM map)
  GROUP BY k."id"
)
UPDATE "api_keys" k SET "scopes" = w.scopes FROM widened w WHERE w."id" = k."id";

-- 3) catalog rows (user-service would add them at boot anyway)
INSERT INTO "permissions" ("code", "module", "type") VALUES
  ('crm.lead.read', 'crm', 'human'),
  ('crm.lead.read.all', 'crm', 'human'),
  ('crm.lead.manage', 'crm', 'human'),
  ('integration.crm.lead.manage', 'integration', 'service'),
  ('integration.crm.lead.read.all', 'integration', 'service')
ON CONFLICT ("code") DO NOTHING;

-- 4) role: ทุก role ที่ถือ crm.sales.X ได้ crm.lead.X
INSERT INTO "role_permissions" ("roleId", "permissionCode")
SELECT rp."roleId", m.new
FROM "role_permissions" rp
JOIN (VALUES
  ('crm.sales.read', 'crm.lead.read'),
  ('crm.sales.read.all', 'crm.lead.read.all'),
  ('crm.sales.manage', 'crm.lead.manage')
) AS m(old, new) ON m.old = rp."permissionCode"
ON CONFLICT ("roleId", "permissionCode") DO NOTHING;

-- ย้อนกลับ: ลบ role_permissions ของ crm.lead.*, ถอด integration.crm.lead.read|manage ที่ข้อ 2 เพิ่ม,
-- แล้ว array_replace(.read.all → .read) — key ที่ถือ integration.crm.lead.read อยู่แล้วก่อนข้อ 1
-- คือ key ของเครื่องทั้งหมด จึงคืนได้ตรง ๆ.
