# ตัวอย่าง — AI agent ทำงานกับ Lead ผ่าน API key + Webhook

ไฟล์นี้สำหรับ **AI agent ที่ทำงานแทนบริษัท** ไม่ได้ทำแทนพนักงานคนใดคนหนึ่ง จึง**ไม่ต้องส่ง `X-Acting-User`**
ทุกคำสั่งในไฟล์ใช้ key อย่างเดียว ส่วน route ที่ทำแทนคน (`crm/leads/*` คู่กับ `X-Acting-User`) อยู่ใน
[`use-case-curl.md`](./use-case-curl.md)

| | ทำแทนคน (`crm/leads/*`) | AI agent (ไฟล์นี้) |
|---|---|---|
| ใครทำรายการ | คนที่ระบุใน `X-Acting-User` | service account ของ key |
| เห็น Lead ใบไหน | ตามขอบเขตของคนนั้น | **ทุกใบของบริษัทที่ key ผูกไว้** (ข้ามบริษัทไม่ได้) |
| ทำอะไรได้ | ตามสิทธิ์ของคนนั้น | ตาม scope ที่ติ๊กไว้บน key |
| email / เบอร์โทร | เห็น | เห็นเฉพาะเมื่อ key มี `integration.crm.lead.contact.read` |

---

## 1. ออก API key ให้ AI

ไปที่หน้า **ผู้ดูแล → ระบบภายนอก** (`/pages/admin/integrations`) เพิ่มระบบ เลือก "AI ทำงาน Lead แทนบริษัท"
(เรียกได้แบบ "ในนามบริษัท") แล้วออก key ในแท็บ **กุญแจ API** — key ที่ออกจากหน้านี้**ผูกบริษัท**เสมอ
(route ของ AI ไม่รับ key ที่ไม่ผูกบริษัท) ชุดสำเร็จรูปติ๊ก scope ให้ แล้วเพิ่ม/เอาออกตาม use case ที่ agent ต้องใช้:

| use case | route | scope |
|---|---|---|
| สร้าง Lead | `POST crm/leads/intake` | `integration.crm.lead.create` |
| เปลี่ยนสถานะ | `POST crm/leads/{id}/stage` | `integration.crm.lead.stage` |
| แก้ข้อมูล Lead | `PATCH crm/ai/leads/{id}` | `integration.crm.lead.update` |
| แก้ intake data (JSON) | `PATCH crm/ai/leads/{id}/intake-data` | `integration.crm.lead.update` |
| แปลงเป็นโอกาสการขาย | `POST crm/ai/leads/{id}/convert` | `integration.crm.lead.convert` |
| อ่าน Lead | `GET crm/ai/leads/{id}` | `integration.crm.lead.read` |
| อ่าน email/เบอร์ของ Lead | (route เดียวกับบรรทัดบน) | `integration.crm.lead.read` + `integration.crm.lead.contact.read` |

ค่าที่ใช้ในทุกคำสั่งข้างล่าง (แทนค่าของคุณเอง)

```bash
BASE=http://192.168.31.52:3503/api/v1      # external-service
KEY=rfk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx   # key ที่ออกในข้อ 1
```

## 2. ตั้ง webhook ให้ระบบเรียก agent เมื่อ Lead เปลี่ยน

ไปที่แท็บ **Webhook** ของระบบเดียวกันในหน้า **ผู้ดูแล → ระบบภายนอก** (สิทธิ์ `admin.integration.manage`)

1. URL: ปลายทางของ agent ต้องเป็น `https://` (ถ้าเป็น http หรือ host ภายใน ต้องให้ ops ใส่ host ไว้ใน `WEBHOOK_PRIVATE_HOSTS`)
2. event: เลือก `lead.created` `lead.updated` `lead.status_changed` `lead.intake_updated` `lead.converted`
3. เก็บ **secret** (`whsec_…`) ไว้ทันที เพราะระบบแสดงให้ดูครั้งเดียว
4. กด **ทดสอบ** ระบบจะส่ง `webhook.ping` ในรอบถัดไป (ค่าเริ่มต้นทุก 15 วินาที ตั้งได้ที่ `WEBHOOK_INTERVAL_MS`) แล้วดูผลได้ที่ **ประวัติการส่ง**

ลองรับได้ด้วยตัวอย่างใน [`lead-webhook-receiver.mjs`](./lead-webhook-receiver.mjs)

```bash
WEBHOOK_SECRET=whsec_... PORT=8787 node docs/ex/lead-webhook-receiver.mjs
node docs/ex/lead-webhook-receiver.mjs --self-test   # ทดสอบการตรวจลายเซ็น ไม่ต้องมีเครือข่าย
```

### body ที่ agent ได้รับ

ทุกครั้งมี header สองชุด ตรวจชุดใดชุดหนึ่งก็พอ:

| ชุด | header | ลายเซ็น |
|---|---|---|
| [Standard Webhooks](https://www.standardwebhooks.com/) (แนะนำ, ตั้งแต่ 22 ต.ค. 2569) | `webhook-id`, `webhook-timestamp` (วินาที), `webhook-signature: v1,<base64>` | `HMAC-SHA256(bytes ของ secret หลัง whsec_ ที่ decode base64, "<id>.<timestamp>.<body ดิบ>")` — ใช้ library `standardwebhooks` ได้เลย |
| เดิม | `X-Webhook-Id`, `X-Webhook-Event`, `X-Webhook-Timestamp`, `X-Webhook-Signature: sha256=<hex>` | `HMAC-SHA256(secret ทั้งสตริง, "<timestamp>.<body ดิบ>")` |

`webhook-id` = `X-Webhook-Id` = `id` ใน body ใช้กันรับซ้ำได้ (ส่งซ้ำเมื่อ retry)

**secret ที่ออกก่อน 22 ต.ค. 2569** เป็น base64url — ตัวอย่างข้างบนตรวจได้ แต่ library `standardwebhooks` อาจ decode ไม่ได้ (ตอบว่าลายเซ็นผิด) ให้กด **ออก secret ใหม่** ที่หน้า Webhook ก่อนเปลี่ยนไปใช้ library

```json
{
  "id": "5b0c8e9e-6a0f-4c55-9a7e-2f1f0f4b7c11",
  "event": "lead.status_changed",
  "created_at": "2026-10-22T03:15:02.114Z",
  "data": {
    "company_id": "osd",
    "lead_id": "8d2f7a4e-1c3b-4e5f-9a6d-0b1c2d3e4f50",
    "name": "บจก. ตัวอย่าง เทคโนโลยี",
    "status": "contacted",
    "source_code": "ai-agent",
    "previous_status": "new"
  }
}
```

| event | field เพิ่มใน `data` |
|---|---|
| `lead.created` | – |
| `lead.updated` | `changed_fields` (ชื่อ field ที่ส่งมาแก้) |
| `lead.status_changed` | `previous_status`, `reason` (กรณีคัดออก) |
| `lead.intake_updated` | `changed_fields` (ชื่อ key ใน intake data) |
| `lead.converted` | `previous_status`, `opportunity_id`, `opportunity_code` |

**body ไม่มี email หรือเบอร์โทร** ถ้าต้องการ ให้เรียก `GET crm/ai/leads/{lead_id}` (ข้อ 3.6) ซึ่งต้องผ่าน scope `contact.read`
เพียงด่านเดียว ไม่ว่าใครจะตั้ง webhook ไว้

---

## 3. use case ทั้ง 6

### 3.1 สร้าง Lead (ใบจะเข้ากองกลาง รอพนักงานขายรับ)

```bash
curl -s -X POST "$BASE/crm/leads/intake" \
  -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: 6f6bd3a7-7308-4d2e-a4de-75e1f89b6871' \
  -d '{
    "name": "บจก. ตัวอย่าง เทคโนโลยี",
    "contact_name": "คุณสมชาย",
    "email": "somchai@example.com",
    "phone": "0812345678",
    "note": "สนใจระบบกล้อง 40 จุด",
    "intake_data": { "budget_range": "1-3M", "interested_in": ["CCTV", "Network"] }
  }'
```

ตอบ `{ id, name, status, source_code, owner_user_id: null, created_at, outcome }` และทำให้เกิด `lead.created`
ช่องทาง (`source_code`) มาจาก key ถ้า key ไม่ได้ผูกช่องทางไว้ ต้องส่ง `source_code` มาใน body ด้วย

### 3.2 เปลี่ยนสถานะ

```bash
curl -s -X POST "$BASE/crm/leads/$LEAD_ID/stage" \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{ "stage": "contacted", "reason": "AI โทรติดต่อได้แล้ว" }'
```

`stage` เป็นรหัสสถานะแบบ `open` ของบริษัท (ค่าเริ่มต้นคือ `new` `cannot_contact` `contacted` `qualified`)
สถานะปิดอย่าง won/lost ใช้ route นี้ไม่ได้ ต้องใช้ convert (3.5) หรือคัดออก ถ้าส่งสถานะเดิมซ้ำจะได้ `changed: false` และไม่มี event

### 3.3 แก้ข้อมูล Lead

```bash
curl -s -X PATCH "$BASE/crm/ai/leads/$LEAD_ID" \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{ "industry": "ค้าปลีก", "employee_count": 120, "discovery_need": "กล้องหน้าร้าน 12 สาขา" }'
```

ส่งเฉพาะ field ที่ต้องการเปลี่ยน ถ้าส่ง `intake_data` มาที่ route นี้จะได้ 422 (ใช้ 3.4 แทน)

### 3.4 แก้ intake data (JSON)

```bash
# merge: เขียน budget_range และลบ old_key
curl -s -X PATCH "$BASE/crm/ai/leads/$LEAD_ID/intake-data" \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{ "data": { "budget_range": "3-5M", "old_key": null } }'

# replace: แทนทั้งก้อน
curl -s -X PATCH "$BASE/crm/ai/leads/$LEAD_ID/intake-data" \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{ "data": { "score": 82 }, "replace": true }'
```

แบบ merge ระบบเขียนใน statement เดียว ถ้าสองระบบเขียนคนละ key พร้อมกันจะไม่ทับกัน ขนาดรวมต้องไม่เกิน 16 KB

### 3.5 แปลงเป็นโอกาสการขาย

```bash
curl -s -X POST "$BASE/crm/ai/leads/$LEAD_ID/convert" \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{ "title": "CCTV 12 สาขา", "amount": 2500000 }'
```

โอกาสการขายจะเป็นของ**เจ้าของ Lead** ส่วน Lead ที่ยังอยู่ในกองกลาง (ไม่มีเจ้าของ) จะได้ `409` ต้องให้คนรับใบหรือแจกใบก่อน

### 3.6 อ่าน Lead และ email

```bash
curl -s "$BASE/crm/ai/leads/$LEAD_ID" -H "Authorization: Bearer $KEY" | jq '{name, status, email, phone, intakeData}'
```

ถ้า key ไม่มี `integration.crm.lead.contact.read` ช่อง `email` `phone` `contactName` `contactPosition` จะเป็น `null`

---

## 4. error ที่เจอบ่อย

| code | สาเหตุ |
|---|---|
| `401` | key ผิด หมดอายุ หรือถูกเพิกถอน |
| `403 FORBIDDEN` | key ไม่มี scope ของ route นี้ หรือเป็น key ที่ไม่ผูกบริษัท |
| `404 NOT_FOUND` | ไม่มี Lead นี้ในบริษัทของ key ระบบไม่บอกว่ามีอยู่ในบริษัทอื่นหรือไม่ |
| `409 CONFLICT` | Lead ปิดไปแล้ว, สถานะปลายทางเป็นสถานะปิด หรือ convert ใบในกองกลาง |
| `422 VALIDATION_FAILED` | body ไม่ถูกต้อง, intake data เกิน 16 KB หรือส่ง `intake_data` มาที่ `PATCH crm/ai/leads/{id}` |
