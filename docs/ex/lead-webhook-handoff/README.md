# ชุดเริ่มต้น — รับ Webhook ของ Lead และเรียก API กลับ

สำหรับทีมพัฒนาเว็บที่จะเชื่อมกับ Request Form Service: ระบบเราจะ **เรียกเว็บของคุณ** เมื่อ Lead เปลี่ยน
แล้วเว็บของคุณ **เรียก API ของเรากลับ** เพื่ออ่านรายละเอียดหรือทำงานกับ Lead ต่อ

| ไฟล์ | ใช้ทำอะไร |
|---|---|
| `README.md` | ไฟล์นี้ — ลำดับเริ่มงานและกติกาฝั่งรับ |
| `lead-webhook.md` | คู่มือเต็ม: scope ของ key, body ของ event, curl ของ use case Lead ทั้ง 6 |
| `lead-webhook-receiver.mjs` | ตัวรับตัวอย่าง Node 18+ ไม่มี dependency — คัดลอกไปเป็นจุดเริ่มได้ |
| `external-webhook.json` | OpenAPI 3.1 `webhooks` — เฉพาะ `lead.*` 5 event กับ `webhook.ping` และ schema ของ body |
| `external-crm.json` | OpenAPI ของ CRM API เฉพาะ route ของ Lead (22 path) — สร้าง client ได้ |

## 1. ขอค่าจากผู้ดูแลระบบของเรา

ส่งรายการนี้ให้ผู้ดูแลของเรา:

- [ ] URL ที่รับ webhook — ต้องเป็น `https://` และตอบจากอินเทอร์เน็ตได้ (ถ้าเป็นเครือข่ายภายใน แจ้งให้ใส่ host ในรายการที่อนุญาต)
- [ ] event ที่ต้องการ — เลือกจาก `lead.created` `lead.updated` `lead.status_changed` `lead.intake_updated` `lead.converted`
- [ ] งานที่จะทำกับ Lead — ทำในนามบริษัท (ตามไฟล์นี้) หรือทำแทนพนักงานรายคน (ดูข้อ 6)

แล้วคุณจะได้กลับมา 3 ค่า เก็บไว้ใน secret store ห้าม commit:

| ค่า | ตัวอย่าง | ใช้ที่ |
|---|---|---|
| BASE URL | `https://<host>/api/v1` | ทุก request ไป API ของเรา |
| API key | `rfk_xxxxxxxx…` | header `Authorization: Bearer <key>` |
| Webhook secret | `whsec_...` | ตรวจลายเซ็น webhook (แสดงให้ผู้ดูแลเห็นครั้งเดียว ถ้าหายต้องออกใหม่) |

ใน `lead-webhook.md` BASE เขียนเป็น `http://192.168.31.52:3503/api/v1` ซึ่งเป็นเครื่องทดสอบภายในของเรา ให้แทนด้วยค่าที่ได้รับ

## 2. ลองตัวรับตัวอย่าง

```bash
node lead-webhook-receiver.mjs --self-test                    # ต้องได้ ok ครบ 7 บรรทัด
WEBHOOK_SECRET=whsec_... PORT=8787 node lead-webhook-receiver.mjs
```

เปิดตัวรับไว้ที่ URL ที่แจ้งไป แล้วขอให้ผู้ดูแลกด **ทดสอบ** ในหน้าตั้งค่า Webhook — ภายในประมาณ 15 วินาที
ตัวรับจะพิมพ์ `ping จาก webhook …` ผู้ดูแลเปิด **ประวัติการส่ง** เพื่อดู status code ที่เว็บคุณตอบได้

## 3. ลำดับการทำงาน

```
Lead เปลี่ยนในระบบเรา
   → POST https://เว็บของคุณ/...   (body บาง: id, event, lead_id, status)
   → เว็บคุณตรวจลายเซ็น → ตอบ 2xx ภายใน 10 วินาที → ทำงานต่อเบื้องหลัง
   → ถ้าต้องการรายละเอียด: GET {BASE}/crm/ai/leads/{lead_id}  ด้วย API key
```

body ไม่มี email หรือเบอร์โทร — อ่านจาก GET ข้างบน ซึ่งต้องมี scope `integration.crm.lead.contact.read`

## 4. กติกาฝั่งรับ (สำคัญ)

1. **ตรวจลายเซ็นจาก body ดิบ ก่อน `JSON.parse`** — parse แล้ว stringify ใหม่จะได้ byte ไม่ตรง ลายเซ็นจะผิด
   ทุกครั้งมี header 2 ชุด ตรวจชุดเดียวก็พอ:
   - `webhook-id` / `webhook-timestamp` / `webhook-signature` ([Standard Webhooks](https://www.standardwebhooks.com/)) — แนะนำ ใช้ library `standardwebhooks` แทนฟังก์ชัน `verify` ในตัวอย่างได้
   - `X-Webhook-Id` / `X-Webhook-Timestamp` / `X-Webhook-Signature: sha256=<hex>` — สูตรอยู่ใน `lead-webhook.md`
2. **ปฏิเสธ timestamp ที่ห่างจากเวลาปัจจุบันเกิน 5 นาที** กันการนำ request เก่ามายิงซ้ำ
3. **ตอบ 2xx ให้เร็ว** ถ้าไม่ตอบใน 10 วินาที หรือตอบอย่างอื่น ระบบจะส่งซ้ำหลัง 1 นาที, 5 นาที, 30 นาที, 2 ชั่วโมง, 6 ชั่วโมง (รวม 6 ครั้ง) แล้วเลิกส่ง
4. **ตัดรายการซ้ำด้วย `webhook-id`** (= `id` ใน body) เก็บในตาราง ไม่ใช่ใน memory — การส่งซ้ำใช้ id เดิม
5. **ลำดับ event อาจสลับ** อย่าเชื่อ `status` ใน body ว่าเป็นค่าล่าสุด ถ้าสำคัญให้ GET อ่านค่าปัจจุบัน
6. **ระบบไม่ตาม redirect** — 3xx นับเป็นส่งไม่สำเร็จ ให้ใส่ URL ปลายทางจริง
7. **event อาจหายได้ในจังหวะที่ระบบล่ม** (best-effort) ถ้าเว็บคุณล่มไปนาน ให้ตรวจสอบย้อนหลังด้วย GET

## 5. event ของ Lead

ทุก `lead.*` มี `company_id` `lead_id` `name` `status` (สถานะหลังเหตุการณ์) `source_code` (ช่องทางที่ Lead เข้ามา)

| event | ส่งเมื่อ | ไม่ส่งเมื่อ | field เพิ่มใน `data` |
|---|---|---|---|
| `lead.created` | มี Lead ใหม่ทุกช่องทาง: หน้าจอ, `crm/leads/intake`, ฟอร์มแคมเปญ, ads, import (หนึ่ง event ต่อแถว) | – | – |
| `lead.updated` | แก้ข้อมูล Lead (`PATCH crm/leads/{id}` หรือ `crm/ai/leads/{id}`) | เปลี่ยนเจ้าของ, ลงกิจกรรม | `changed_fields` ชื่อ field ที่ถูกส่งมา ไม่มีค่า (อาจมีแม้ค่าไม่เปลี่ยน) |
| `lead.status_changed` | สถานะเปลี่ยนจริง: `stage`, หน้าจอ, หรือคัดออก | ส่งสถานะเดิมซ้ำ, convert (ได้ `lead.converted` แทน) | `previous_status`, `reason` (คัดออก หรือส่งมากับ `stage`) |
| `lead.intake_updated` | แก้ intake data แบบ merge หรือ replace | – | `changed_fields` ชื่อ key ที่ถูกส่งมา |
| `lead.converted` | แปลงเป็นโอกาสการขาย (event เดียว) | – | `previous_status`, `opportunity_id`, `opportunity_code` |
| `webhook.ping` | ผู้ดูแลกด **ทดสอบ** — ไม่ใช่ข้อมูลจริง | webhook ถูกปิด | มีแค่ `company_id`, `webhook_id` (ไม่มี field ของ Lead) |

**การแจกหรือเปลี่ยนเจ้าของ Lead ไม่มี event** ถ้าต้องรู้ ให้ GET อ่านเป็นระยะ

ตัวอย่าง body ของแต่ละ event (เปิด `external-webhook.json` ใน Swagger Editor หรือ Redoc ก็เห็นเหมือนกัน):

```json
{ "id": "5b0c8e9e-…", "event": "lead.created", "created_at": "2026-10-22T03:15:02.114Z",
  "data": { "company_id": "osd", "lead_id": "8d2f7a4e-…", "name": "บจก. ตัวอย่าง เทคโนโลยี", "status": "new", "source_code": "web-form" } }

{ "id": "…", "event": "lead.updated", "created_at": "…",
  "data": { "company_id": "osd", "lead_id": "8d2f7a4e-…", "name": "…", "status": "contacted", "source_code": "web-form",
            "changed_fields": ["industry", "employee_count"] } }

{ "id": "…", "event": "lead.status_changed", "created_at": "…",
  "data": { "company_id": "osd", "lead_id": "8d2f7a4e-…", "name": "…", "status": "contacted", "source_code": "web-form",
            "previous_status": "new" } }

{ "id": "…", "event": "lead.intake_updated", "created_at": "…",
  "data": { "company_id": "osd", "lead_id": "8d2f7a4e-…", "name": "…", "status": "qualified", "source_code": "web-form",
            "changed_fields": ["budget_range"] } }

{ "id": "…", "event": "lead.converted", "created_at": "…",
  "data": { "company_id": "osd", "lead_id": "8d2f7a4e-…", "name": "…", "status": "won", "source_code": "web-form",
            "previous_status": "qualified", "opportunity_id": "3c9a1f2e-…", "opportunity_code": "OPP-2610-0001" } }

{ "id": "…", "event": "webhook.ping", "created_at": "…",
  "data": { "company_id": "osd", "webhook_id": "0f1e2d3c-…" } }
```

รหัสสถานะ (`new`, `contacted`, `won` …) เป็นของแต่ละบริษัท อ่านรายการจริงได้จาก `GET crm/leads/statuses`

ตัวอย่าง body และ curl ของทุก use case (สร้าง, เปลี่ยนสถานะ, แก้ข้อมูล, แก้ intake data, convert, อ่าน) อยู่ใน `lead-webhook.md` ข้อ 2–3
ในชุดนี้ `lead-webhook-receiver.mjs` อยู่โฟลเดอร์เดียวกัน — คำสั่งใน `lead-webhook.md` ที่เขียน `docs/ex/` ให้ตัดส่วนนั้นออก

## 6. ถ้าต้องทำแทนพนักงานรายคน

route ในชุดนี้ทำในนามบริษัท (เห็น Lead ทุกใบของบริษัทที่ key ผูกไว้) ถ้าเว็บของคุณให้พนักงาน login แล้วทำรายการ
ในนามคนนั้น (`crm/leads/*` คู่กับ header `X-User-Token`) ใช้ route และสิทธิ์คนละชุด — ขอคู่มือ `use-case-curl.md` จากเราแยก
