-- Products from brochures in source/file_pdf2 (17 Nov 2026), for OSD and D CALL. Plain SQL — runs as one
-- script in DBeaver/DataGrip (Execute script) or psql; the last SELECT shows the result. Safe to re-run.
--
--   Needs: migration 20261117120000_product_description (products.description) — backend 1.5.54+.
--   Sources: [Brochure]D-DEBT.pdf · [TH]/[EN]Zoom_Phone_Contact_Center_and_BYOC_1.pdf
--   Gaps, not filled: unit (no brochure states one) · D-CALLCENTER's description (no brochure describes it;
--   D-DEBT only says it syncs with D-Call Center) — fill when a source exists.

INSERT INTO products (id, "companyId", code, name, description, unit, active, source, "syncedAt", "updatedAt")
SELECT gen_random_uuid()::text, c.id, v.code, v.name, v.description, NULL, true, 'manual', now(), now()
FROM companies c
CROSS JOIN (VALUES
  ('D-DEBT',
   'D-DEBT Collection Management',
   'แพลตฟอร์มบริหารการติดตามหนี้ (Collection Management) สำหรับธนาคาร สถาบันการเงิน ผู้ให้สินเชื่อ และบริษัทรับจ้างติดตามหนี้ (Outsourcing OA) '
   || 'ช่วยลดหนี้ค้างชำระและ NPL: จัดสรรงานให้ agent อัตโนมัติตามกฎ (Data / Lead Management), ดูประวัติและการติดตามลูกหนี้ (Debt Management), '
   || 'รายงานและ dashboard สรุปผลการติดตามหนี้, เตือนความถี่การโทรให้เป็นไปตามกฎหมาย และเชื่อมกับ D-Call Center เพื่อเตือนเมื่อการโทรถูกจำกัด · '
   || 'รองรับ AI, เชื่อม API และระบบภายนอก, ติดตั้งได้ทั้ง on-premise และ cloud, ขยายระบบได้'),
  ('ZOOM-BUNDLE',
   'Zoom Phone + Contact Center + BYOC (Zoom + OSD)',
   'ชุด Zoom Phone, Zoom Contact Center และ Zoom BYOC โดย OSD ผู้ให้บริการโทรคมนาคมที่มีใบอนุญาตในไทย: '
   || 'Zoom Phone ระบบโทรศัพท์บน cloud (HD voice, call routing ขั้นสูง, เชื่อมกับ meetings และ messaging) · '
   || 'Zoom Contact Center แบบ omnichannel (voice, video, chat, intelligent routing, real-time analytics, เชื่อม CRM) · '
   || 'BYOC ใช้ผู้ให้บริการโทรศัพท์เดิมผ่าน SIP trunk แบบ hybrid ประหยัดค่าใช้จ่าย · '
   || 'รองรับเบอร์โทรไทยและข้อกำหนดในประเทศ พร้อมทีม support ในไทย')
) AS v(code, name, description)
WHERE c.code IN ('OSD', 'DCALL')
ON CONFLICT ("companyId", code) DO UPDATE
SET name = EXCLUDED.name, description = EXCLUDED.description, "updatedAt" = now();

-- Result: every product of OSD and D CALL, with or without a description
SELECT c.code AS company, p.code, p.name, p.active, p.source,
       left(p.description, 60) AS description_start
FROM products p
JOIN companies c ON c.id = p."companyId"
WHERE c.code IN ('OSD', 'DCALL')
ORDER BY c.code, p.code;
