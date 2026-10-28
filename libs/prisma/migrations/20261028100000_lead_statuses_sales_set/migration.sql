-- สถานะ Lead ชุดเก้าขั้นของฝ่ายขาย (28 ต.ค. 2569):
--   ลูกค้าใหม่ → ติดต่อไม่ได้ → ติดต่อได้ ยังไม่ qualify → Qualified → Proposal
--   → Negotiation → Won | Lost | Disqualified
--
-- เพิ่มสามขั้นใหม่ให้ทุกบริษัท (ข้ามบริษัทที่มีรหัสนั้นอยู่แล้ว):
--   proposal, negotiation — ขั้นระหว่างทาง (open)
--   lost                  — ปลายทางชนิด lost ตัวที่สอง คู่กับ disqualified;
--                           เลือกได้ตอนปิด Lead
-- `converted` ยังเป็นปลายทาง won ตัวเดิม แค่เปลี่ยนชื่อที่แสดงเป็น Won.
--
-- เปลี่ยนชื่อเฉพาะแถวที่ยังเป็นชื่อตั้งต้นเดิม — ชื่อที่ผู้ดูแลตั้งเองไม่ถูกทับ.

INSERT INTO "lead_statuses" (
  "id", "companyId", "code", "nameTh", "kind", "color",
  "isDefault", "isSystem", "sortOrder", "updatedAt"
)
SELECT
  gen_random_uuid()::text,
  c."id",
  d."code",
  d."nameTh",
  d."kind"::"LeadStatusKind",
  d."color",
  false,
  false,
  d."sortOrder",
  CURRENT_TIMESTAMP
FROM "companies" c
CROSS JOIN (
  VALUES
    ('proposal',    'Proposal (Proposal Stage)', 'open', 'geekblue', 43),
    ('negotiation', 'Negotiation (Negotiation)', 'open', 'gold',     46),
    ('lost',        'Lost (Lost Lead)',          'lost', 'volcano',  55)
) AS d("code", "nameTh", "kind", "color", "sortOrder")
-- บริษัทที่ยังไม่เคยมีชุดสถานะ ได้ชุดเต็มตอนอ่านครั้งแรก (LeadStatusService)
WHERE EXISTS (SELECT 1 FROM "lead_statuses" s WHERE s."companyId" = c."id")
ON CONFLICT ("companyId", "code") DO NOTHING;

UPDATE "lead_statuses" s
SET "nameTh" = d."newName", "updatedAt" = CURRENT_TIMESTAMP
FROM (
  VALUES
    ('new',            'ใหม่',                     'ลูกค้าใหม่ (New)'),
    ('cannot_contact', 'ติดต่อไม่ได้',              'ติดต่อไม่ได้ (Cannot Contact)'),
    ('contacted',      'ติดต่อแล้ว',                'ติดต่อได้ ยังไม่ qualify (Contacted)'),
    ('qualified',      'ผ่านคัดกรอง',               'Qualified (Qualified)'),
    ('converted',      'แปลงเป็นโอกาสการขายแล้ว',     'Won (Won Lead)'),
    ('disqualified',   'คัดออก',                    'Disqualified (Disqualified)')
) AS d("code", "oldName", "newName")
WHERE s."code" = d."code" AND s."nameTh" = d."oldName";
