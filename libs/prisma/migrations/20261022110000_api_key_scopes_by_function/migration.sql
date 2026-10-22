-- scope ของ key ตามฟังก์ชัน (22 ต.ค. 2569): `integration.` + สิทธิ์ผู้ใช้ที่ route ใช้.
-- key ทุกใบได้ชุดชื่อใหม่ที่ทำได้เท่าเดิม — ทั้ง REST และ MCP (ซึ่งตอนนี้ตรวจ key ทีละ tool).
-- แถว (old, old) = เก็บชื่อเดิมไว้ด้วย; ชื่อที่ไม่มีแถวตัวเองถูกแทนที่.
WITH map(old, new) AS (VALUES
  ('integration.request.create', 'integration.request.create'),
  ('integration.request.create', 'integration.request.read'),
  ('integration.request.create', 'integration.request.complete'),
  ('integration.request.create', 'integration.request.hold'),
  ('integration.request.create', 'integration.request.return'),
  ('integration.request.create', 'integration.request.cancel.own'),
  ('integration.request.create', 'integration.approval.decide'),
  -- MCP assistant tools ที่ทางเข้า MCP เคยเปิดให้
  ('integration.request.create', 'integration.assistant.read'),
  ('integration.request.create', 'integration.service.asset.read'),
  ('integration.crm.admin.manage', 'integration.admin.crm.manage'),
  ('integration.crm.sales.manage', 'integration.crm.sales.manage'),
  ('integration.crm.sales.manage', 'integration.crm.campaign.manage'),
  ('integration.crm.sales.manage', 'integration.crm.target.manage'),
  ('integration.crm.customer.read', 'integration.crm.customer.read'),
  ('integration.crm.customer.read', 'integration.crm.customer.financial.read'),
  ('integration.disbursement.manage', 'integration.disbursement.pay'),
  ('integration.disbursement.manage', 'integration.disbursement.verify'),
  ('integration.disbursement.manage', 'integration.request.create'),
  ('integration.disbursement.read', 'integration.request.read'),
  ('integration.flow.read', 'integration.crm.sales.read'),
  ('integration.presales.read', 'integration.presales.solution.read'),
  ('integration.presales.read', 'integration.crm.sales.read'),
  ('integration.legal.read', 'integration.legal.contract.read'),
  ('integration.pm.read', 'integration.pm.project.read'),
  ('integration.pm.manage', 'integration.pm.project.manage'),
  ('integration.support.read', 'integration.service.asset.read'),
  ('integration.support.manage', 'integration.service.asset.manage'),
  ('integration.assistant.read', 'integration.assistant.read'),
  ('integration.assistant.read', 'integration.crm.sales.read'),
  ('integration.assistant.read', 'integration.approval.decide'),
  ('integration.assistant.read', 'integration.service.asset.read'),
  ('integration.care.manage', 'integration.service.care.manage'),
  ('integration.smart.ingest', 'integration.smart.prospect.create'),
  ('integration.smart.callcenter', 'integration.smart.call.update')
),
renamed AS (
  SELECT k."id", array_agg(DISTINCT COALESCE(m.new, s) ORDER BY COALESCE(m.new, s)) AS scopes
  FROM "api_keys" k
  CROSS JOIN LATERAL unnest(k."scopes") AS s
  LEFT JOIN map m ON m.old = s
  WHERE k."scopes" && ARRAY(SELECT DISTINCT old FROM map)
  GROUP BY k."id"
)
UPDATE "api_keys" k SET "scopes" = r.scopes FROM renamed r WHERE r."id" = k."id";

-- ย้อนกลับ (ชื่อใหม่ทุกตัวไม่เคยมีมาก่อน จึงถอดออกได้ตรง ๆ):
--   แทน admin.crm.manage → crm.admin.manage, disbursement.pay|verify → disbursement.manage,
--   legal.contract.read → legal.read, pm.project.* → pm.*, service.asset.* → support.*,
--   service.care.manage → care.manage, smart.prospect.create → smart.ingest,
--   smart.call.update → smart.callcenter, presales.solution.read → presales.read
--   แล้วถอด request.read|complete|hold|return|cancel.own, approval.decide,
--   crm.campaign|target.manage, crm.customer.financial.read, assistant.read ที่เพิ่มเข้าไป.
