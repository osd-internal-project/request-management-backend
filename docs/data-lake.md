# Data Lake (CD-90)

ข้อมูลดิบจากโมดูลระยะที่ 1 — Platform Request, CRM, Sales และข้อมูลอ้างอิง — และจาก SAP
ไหลลง **database PostgreSQL แยก** (warehouse) ที่ core-service ป้อนให้เอง
(user decisions 29 ก.ย. 2569: Postgres แยก · ดึงส่วนที่เปลี่ยนทุกชั่วโมง · ข้อมูลอ่อนไหวไม่เข้า lake)

| | ที่อยู่ | ใช้ทำอะไร |
|---|---|---|
| Data Mart (CD-91) | schema `mart` ใน DB ระบบ | ตัวเลขที่ผู้บริหารดูประจำ เตรียมไว้แล้ว |
| **Data Lake (CD-90)** | database แยก `LAKE_DATABASE_URL` | ข้อมูลดิบทุกเวอร์ชันย้อนหลัง ให้วิเคราะห์/ทำ mart ใหม่ได้โดยไม่แตะ DB ระบบ |

## โครงสร้างใน lake

- `raw.<table>` — **ทุกเวอร์ชัน** ของแถว: `id`, `_source_ts` (เวลาที่แถวเปลี่ยนในระบบ), `_extracted_at`, `data` (JSONB ของแถวทั้งแถว ยกเว้นคอลัมน์ต้องห้าม) · คีย์ `(id, _source_ts)` — ดึงซ้ำไม่เกิดแถวซ้ำ
- `latest.<table>` — view แถวล่าสุดต่อ `id`
- `raw._state` — ต่อตาราง: ดึงถึงเวลาใด (`watermark` + `last_id`), รอบล่าสุด, จำนวนสะสม, ข้อผิดพลาดล่าสุด

ตัวอย่าง: ยอดดีลที่ชนะ ณ วันไหนก็ได้ย้อนหลัง
```sql
SELECT DISTINCT ON (id) id, data->>'stage' AS stage, (data->>'amount')::numeric AS amount
FROM raw.opportunities
WHERE _source_ts <= '2026-09-30'
ORDER BY id, _source_ts DESC;
```

ตาราง lake ถูกสร้างโดย core-service เอง (`LakeRepository.ensureSchema`, idempotent) — ไม่ใช่ Prisma
migration เพราะเป็นคนละ database

## แหล่งข้อมูล

นิยามครบอยู่ที่ `services/core-service/src/lake/lake-sources.ts` (ตาราง, คอลัมน์เวลาที่ใช้ตัด, คอลัมน์ที่ไม่ส่ง)

- **Platform Request:** requests, request_events, request_types, approval_cases, approval_steps, sla_clocks
- **CRM:** customers, customer_locations, customer_contracts, leads, lead_activities
- **Sales:** opportunities, opportunity_activities, quotations, quotation_lines, sale_orders, sale_order_lines, sales_targets, campaigns, sales_handovers
- **อ้างอิง:** companies, org_units, users, products (รายการสินค้าจาก SAP)
- **SAP:** `sap_invoices` — ใบแจ้งหนี้ของลูกค้าที่มีเลข BP วันละครั้ง (หนึ่งเวอร์ชันต่อใบต่อวัน) · ไม่ดึงเมื่อ ERP อยู่ในโหมด mock

ตารางที่ไม่มีเวลาของตัวเอง (บรรทัดใบเสนอราคา/ใบสั่งขาย) ใช้เวลาของเอกสารแม่ · approval ใช้ `GREATEST(createdAt, decidedAt)`

## ข้อมูลที่ไม่เข้า lake (SCOPE-04 / PDPA)

ตัดทิ้งก่อนออกจาก DB ระบบ: เนื้อหาฟอร์มคำขอ (`formData` ฯลฯ) · ต้นทุนและ margin · เลขภาษี · ข้อมูลติดต่อบุคคล
(ชื่อผู้ติดต่อ โทรศัพท์ อีเมล ที่อยู่บรรทัดถนน) · ข้อความอิสระที่อาจมีข้อมูลบุคคล (note, detail) · ข้อมูลบัญชีผู้ใช้
(อีเมล username Keycloak) — `customer_contacts` ไม่ใช่แหล่งข้อมูลเลย. เมื่อระบบ PDPA กลางมา (CD-56..58)
เป็นผู้กำหนดว่าอะไรเพิ่มกลับได้

## การทำงาน

- ทุกชั่วโมง (`LAKE_EXTRACT_INTERVAL_MS`, รอบแรก 1 นาทีหลังเปิดระบบ): ต่อตาราง อ่านแถวที่ `(เวลา, id)` เลย cursor
  ครั้งละ 2,000 แถว (สูงสุด 50 หน้า/รอบ — รอบแรกของตารางใหญ่จึงกระจายไปหลายชั่วโมง) · แต่ละหน้าบันทึกลง lake
  และเลื่อน cursor ใน transaction เดียว · แถวที่เพิ่งเปลี่ยนไม่ถึง 1 นาทีรอรอบถัดไป (กันแถวจาก transaction ที่ยังไม่ commit)
- วันละครั้ง (`LAKE_SAP_INTERVAL_MS`): ใบแจ้งหนี้ SAP ล่าสุด 50 ใบต่อลูกค้า
- ตารางใดล้มเหลว cursor ไม่ขยับ รอบถัดไปลองใหม่ — ตารางอื่นเดินต่อ
- ไม่ตั้ง `LAKE_DATABASE_URL` = ไม่มีอะไรทำงาน · external-service ไม่ป้อน lake
- หน้า **ตั้งค่า BI** มีการ์ด Data Lake: สถานะต่อตาราง + ปุ่ม **ส่งข้อมูลตอนนี้** (`POST /admin/bi/lake/run`, audit `bi.lake.extracted`)

## ติดตั้ง

1. สร้าง database แยก (server เดียวกันหรือคนละเครื่องก็ได้) และ role ที่เขียนได้เฉพาะ database นั้น
2. ตั้ง `LAKE_DATABASE_URL` ใน `.env` ของ core-service แล้ว restart — ตารางถูกสร้างเองในรอบแรก
3. ให้ BI อ่าน: สร้าง role อ่านอย่างเดียวบน lake (`GRANT USAGE ON SCHEMA raw, latest` + `SELECT`) แล้วเพิ่มเป็น database ใน Metabase

`make smoke` สร้าง lake ทิ้งใน container เดียวกันและรันการดึงจริงทุกครั้ง — คอลัมน์ต้นทางที่หายไปทำให้ smoke ไม่ผ่าน
