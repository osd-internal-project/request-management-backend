# curl — DC-RQ-001 D Call คำขอทั่วไป (บริษัท D CALL) · สร้างคำขอ · ดูคำขอ

ยิงจริงบน ctd-uat วันที่ 17 พ.ย. 2569 ด้วย key `help` (`rfk_Md7w3ggv…`) ทุก response ในไฟล์นี้เป็นผลจริง
ยกเว้นที่เขียนว่า **ยังไม่เคยได้จริง**

> **ตอนนี้ยังสร้างคำขอไม่ผ่าน** — 02 ตอบ 400 เพราะ DC-RQ-001 ไม่มีผู้รับเรื่องประจำ ดูวิธีแก้ใน [4. ต้องแก้ก่อน](#4-ต้องแก้ก่อน-02-จะผ่าน)

## 0. ก่อนเริ่ม

### หัวของทุก request

```
Authorization: Bearer <rfk_ key>        ← key ของ integration (สิทธิ์ = scopes ของ key)
```

key นี้ผูกบริษัท D CALL และเปิดโหมด app จึงยิงในนามบริษัทได้โดยไม่ต้องบอกว่าเป็นใคร
**ห้ามส่ง `X-Acting-User`** — integration นี้ไม่ได้เปิดไว้ ส่งไปจะได้ 403 `FORBIDDEN`
"ระบบภายนอกนี้ไม่ได้เปิดให้ระบุผู้ใช้ด้วย X-Acting-User — ส่ง X-User-Token แทน"

ดังนั้นการสร้างคำขอใช้ `POST /request/intake` (ระบบยื่นในนามตัวเอง) ไม่ใช่ `POST /request/requests`
(route นั้นต้องมีคนยื่น คือ `X-User-Token` ของคนนั้น)

```bash
export BASE=https://ctd-uat.osd.co.th/external-api/api/v1
export RFK_KEY=rfk_...                                    # key help (rfk_Md7w3ggv…) — คัดลอกจาก ผู้ดูแลระบบ → ระบบภายนอก
export COMPANY_ID=9f9e6bf4-ece9-49f8-a5e7-8b678a406f88   # D CALL (ต้องตรงกับบริษัทของ key)
export RUN=$(date +%Y%m%d%H%M)                            # ต่อท้าย Idempotency-Key ให้แต่ละรอบไม่ซ้ำ
export REQUEST_REF=                                       # requestNo หรือ id จากคำตอบของ 02
```

`Idempotency-Key` ใส่เฉพาะ 02 (ขั้นที่สร้างข้อมูล) ถ้ายิงซ้ำด้วย key เดิมจะได้คำตอบเดิม ไม่ได้คำขอใบที่สอง
ถ้าไม่ใส่แล้วเน็ตหลุดและยิงซ้ำ จะได้คำขอสองใบ

### input ที่ใช้ได้ — ฟอร์มของ DC-RQ-001 (จาก 01)

| ช่องใน `form_data` | ชื่อบนจอ | ชนิด | บังคับ |
|---|---|---|---|
| `problem` | ปัญหา | ข้อความ | ✔ |
| `customerId` | Customer Id | ข้อความหลายบรรทัด | — |

ช่องอื่นใน body ของ `POST /request/intake`:

| ช่อง | บังคับ | ความหมาย |
|---|---|---|
| `type_code` | ✔ | `DC-RQ-001` |
| `company_id` | ✔ | `$COMPANY_ID` — ใส่บริษัทอื่นได้ 403 `COMPANY_FORBIDDEN` |
| `form_data` | ✔ (ตามฟอร์ม) | ตามตารางบน — ขาด `problem` จะไม่ผ่าน |
| `requester_user_id` | — | uuid ของคนที่ยื่นแทน ไม่ส่ง = ผู้ยื่นเป็น `system (help)` |
| `severity` | — | ความเร่งด่วน (enum `RequestSeverity`) |
| `ref_type`, `ref_id` | — | อ้างอิงเอกสารอื่น (DC-RQ-001 ตั้ง `ref_required: false`) |

`receiver_user_id` **ส่งผ่าน route นี้ไม่ได้** — ส่งไปก็ถูกทิ้งเงียบๆ (ลองแล้ว 17 พ.ย. 17:02) ผู้รับต้องมาจากการตั้งค่าประเภทคำขอ

## 1. ลำดับ

| ขั้น | ทำอะไร | ผลที่ควรได้ | ผลจริง 17 พ.ย. |
|---|---|---|---|
| 01 | ดูฟอร์ม | 200 | 200 ✔ |
| 02 | สร้างและยื่นคำขอ | 201 · `status = submitted` · ได้ `requestNo` | **400** ผู้รับเรื่องไม่ได้ตั้ง |
| 03 | ดูคำขอด้วย id หรือเลขที่ | 200 · คำขอเต็มใบ | 200 ✔ (ใบ draft ที่ 02 ทิ้งไว้) |

## 2. ขั้นตอน

### 01-form

```bash
curl -s "$BASE/request/request-types/DC-RQ-001/form" \
  -H "Authorization: Bearer $RFK_KEY"
```

### 02-create

```bash
curl -s -X POST "$BASE/request/intake" \
  -H "Authorization: Bearer $RFK_KEY" \
  -H "Idempotency-Key: dc-rq-001-$RUN-create" \
  -H "Content-Type: application/json" \
  -d '{
    "type_code": "DC-RQ-001",
    "company_id": "'"$COMPANY_ID"'",
    "form_data": {
      "problem": "ลูกค้าโทรเข้า Call Center ไม่ติด สายตัดหลังรอ 30 วินาที",
      "customerId": "mock-dcall-cus-01"
    }
  }'
```

### 03-get

`$REQUEST_REF` ใส่ได้ทั้ง `requestNo` (เช่น `REQ-…`) และ `id` (uuid)

```bash
curl -s "$BASE/request/requests/$REQUEST_REF" \
  -H "Authorization: Bearer $RFK_KEY"
```

## 3. response ที่ได้

`…` = ตัดออกเพื่อให้สั้น

### 01 · 200

```json
{
  "code": "DC-RQ-001",
  "name": "D Call คำขอทั่วไป",
  "sla_hours": null,
  "ref_required": false,
  "form_schema": {
    "type": "object",
    "required": ["problem"],
    "properties": {
      "problem": { "type": "string", "title": "ปัญหา", "x-order": 1 },
      "customerId": { "type": "string", "title": "Customer Id", "x-order": 2, "x-multiline": true }
    }
  },
  "receiver_form_schema": {
    "type": "object",
    "required": ["summary"],
    "properties": { "summary": { "type": "string", "title": "สรุปผล", "x-order": 1, "x-multiline": true } }
  },
  "required_docs": [],
  "return_reason_codes": [],
  "form_fields": [
    { "key": "problem", "label": "ปัญหา", "type": "text", "required": true, "order": 1 },
    { "key": "customerId", "label": "Customer Id", "type": "multiline", "required": false, "order": 2 }
  ],
  "receiver_form_fields": [{ "key": "summary", "label": "สรุปผล", "type": "multiline", "required": true, "order": 1 }],
  "receiver_org_unit": { "id": "fb698c8a-cebb-4234-917d-10fc83fb9a1e", "name": "D CALL" },
  "receiver_candidates": []
}
```

`receiver_candidates: []` และไม่มีผู้รับประจำ — นี่คือเหตุที่ 02 ไม่ผ่าน

### 02 · 400 (ผลจริงตอนนี้)

```json
{
  "code": "VALIDATION_FAILED",
  "message": "ต้องระบุผู้รับเรื่องก่อนยื่นคำขอ",
  "details": [{ "field": "receiver_user_id", "reason": "required" }]
}
```

แม้จะตอบ 400 แต่ระบบ**สร้างคำขอสถานะ `draft` ทิ้งไว้ทุกครั้ง** (สร้างแถวก่อนแล้วค่อยยื่น) — ตอนนี้ค้าง 3 ใบ ยังไม่มีเลขที่:
`ea72002c-a608-4265-8465-33721fc3609e` (16:56), `1b7d0844-de7a-49cf-a3c8-e8db0cce8e66` (17:00), `2b66aa2d-9ecd-4d82-8a18-5ce61ba4930f` (17:02)

ใบที่ 3 ส่ง `"receiver_user_id": "8a811b4d-4bb1-44d2-9056-481777348347"` (chareefm) มาใน body ด้วย ก็ยังได้ 400 เดิม
route นี้**ทิ้งช่องที่ไม่รู้จักไปเงียบๆ** (ไม่ตอบว่าช่องผิด) draft จึงได้ `receiverUserId: null`

ใบที่ 2 ยิงหลังตั้งทีมผู้รับ RND ให้ DC-RQ-001 แล้ว ก็ยังได้ 400 เดิม และ draft ได้ `receiverOrgUnitId: null`
คือ `POST /request/intake` ไม่ได้นำทีมผู้รับของประเภทคำขอมาใส่ในคำขอ ระบบจึงไม่มีทีมให้เลือกคนรับ

### 02 · 201 (หลังแก้ตามข้อ 4 · **ยังไม่เคยได้จริง**)

รูปร่างเดียวกับ 03 แต่ `status` เป็น `submitted` และมี `requestNo` เก็บค่านั้นไว้ใส่ `$REQUEST_REF`

```json
{
  "id": "<uuid>",
  "requestNo": "<เลขที่ เช่น REQ-DCALL-DC-RQ-001-…>",
  "typeCode": "DC-RQ-001",
  "status": "submitted",
  "receiverUserId": "<ผู้รับที่ตั้งไว้กับประเภทคำขอ>",
  "source": "SYSTEM",
  "submittedAt": "<เวลา>",
  …
}
```

### 03 · 200 — ใบ draft จาก 02 (`$REQUEST_REF = ea72002c-a608-4265-8465-33721fc3609e`)

```json
{
  "id": "ea72002c-a608-4265-8465-33721fc3609e",
  "requestNo": null,
  "requestTypeId": "16f6c386-5ab3-4369-a5ab-4bfa5df125bd",
  "typeCode": "DC-RQ-001",
  "companyId": "9f9e6bf4-ece9-49f8-a5e7-8b678a406f88",
  "requesterId": "031717a3-9c75-4fcd-b972-73ab9a879f60",
  "requesterOrgUnitId": null,
  "receiverUserId": null,
  "assigneeUserId": null,
  "status": "draft",
  "formData": {
    "problem": "ลูกค้าโทรเข้า Call Center ไม่ติด สายตัดหลังรอ 30 วินาที",
    "customerId": "mock-dcall-cus-01"
  },
  "receiverFormData": {},
  "source": "SYSTEM",
  "submittedAt": null,
  "dueAt": null,
  "completedAt": null,
  "closedAt": null,
  "cancelledAt": null,
  "createdAt": "2026-11-17T09:56:56.513Z",
  "updatedAt": "2026-11-17T09:56:56.513Z",
  "requestType": { "id": "16f6c386-…", "code": "DC-RQ-001", "name": "D Call คำขอทั่วไป", "receiverOrgUnitId": "fb698c8a-…", "receiverUserId": null, "formSchema": { … }, … },
  "requester": { "id": "031717a3-9c75-4fcd-b972-73ab9a879f60", "displayName": "system (help)", "email": null, "orgUnit": null, … },
  "receiver": null,
  "assignee": null,
  "slaClock": null,
  "attachments": [], "stepRuns": [], "approvalCases": [], "events": [], "comments": [],
  …
}
```

### error ที่เจอจริง (ทุก error เป็น `{ code, message, details }`)

| เมื่อ | HTTP · `code` | `message` |
|---|---|---|
| 02 ตอนประเภทคำขอยังไม่มีผู้รับ | 400 `VALIDATION_FAILED` | ต้องระบุผู้รับเรื่องก่อนยื่นคำขอ (`receiver_user_id: required`) |
| 03 ใส่เลขที่หรือ id ที่ไม่มี / บริษัทอื่น | 404 `NOT_FOUND` | ไม่พบคำขอที่ระบุ |
| ส่ง `X-Acting-User` มาด้วย | 403 `FORBIDDEN` | ระบบภายนอกนี้ไม่ได้เปิดให้ระบุผู้ใช้ด้วย X-Acting-User — ส่ง X-User-Token แทน |
| 02 ใส่ `company_id` ไม่ใช่ D CALL (จาก code, ยังไม่ได้ยิง) | 403 `COMPANY_FORBIDDEN` | API key นี้ผูกกับบริษัทอื่น — company_id ต้องเป็นบริษัทของ key |

## 4. ต้องแก้ก่อน 02 จะผ่าน

DC-RQ-001 ตั้งไว้แค่**หน่วยผู้รับ** (D CALL) ไม่มี**คนรับประจำ** ส่วนระบบยื่นคำขอต้องมีคนรับเป็นรายคน
(คิวของทั้งแผนกคือคิวที่ไม่มีใครรับผิดชอบ) และ `POST /request/intake` ส่งผู้รับเข้ามาเองไม่ได้

ทางแก้ (เลือกหนึ่ง):
1. **ตั้งผู้รับประจำเป็นรายคนให้ DC-RQ-001** ในหน้าตั้งค่าประเภทคำขอ — แล้ว 02 ตามไฟล์นี้จะได้ 201 ไม่ต้องแก้ curl
   (ตั้งแค่ทีมไม่พอสำหรับ route นี้ — ลองแล้ว 17 พ.ย. 17:00 ยังได้ 400)
2. ใช้ `POST /request/requests` พร้อม `receiver_user_id` (uuid หาได้จาก `GET /request/users?q=<ชื่อ>`)
   ต้องมีคนยื่น: `X-User-Token` (token Keycloak ของคนนั้น) หรือเปิด `allowActingUser` ให้ integration แล้วใช้ `X-Acting-User`

หลังแก้แล้วให้ยิง 02 ใหม่ แล้วเอาผล 201 จริงมาแทนหัวข้อ "02 · 201" ข้างบน
ใบ draft `ea72002c-…` ที่ค้างอยู่ ยกเลิกได้จากหน้าจอ (ระบบไม่ลบคำขอ)
