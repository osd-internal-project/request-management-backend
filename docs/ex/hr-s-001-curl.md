# curl — HR-S-001 HR Request Careers ตั้งแต่เปิดคำขอถึงปิด

HR ยื่นประกาศรับสมัครงาน · อรสา (orasak) รับเรื่อง ทำ และอนุมัติ · HR ปิด
`submitted → in_progress → pending_approval → approved → closed`

ต่างจาก BS-01 ใน [use-case-curl.md](./use-case-curl.md) ตรงที่มีขั้นอนุมัติ**หลังทำงาน**
(`request:HR-S-001` v1) ดังนั้น `complete` จะพาไป `pending_approval` ก่อน ยังไม่ใช่ `approved`

## 0. ก่อนเริ่ม

### หัวของทุก request

```
Authorization: Bearer <rfk_ key>        ← key ของ integration (สิทธิ์ = scopes ของ key)
X-Acting-User: <อีเมลคนที่ทำรายการ>     ← ทำในนามใคร ต้องตรงตัวพิมพ์กับ users.email
```

key ที่ใช้ได้ (เช็คใน DB 12 พ.ย. 2569: active, บริษัท OSD, เปิด `X-Acting-User`, มี scope
`integration.request.create|read|complete` + `integration.approval.decide`):
`aiyara` (`rfk_XDkJRVaC…`) หรือ `all` (`rfk_Deo-KgLN…`) — ดู/คัดลอก key ได้จากหน้า ผู้ดูแลระบบ → ระบบภายนอก
key `rfk_u6g-4Mrm…` ที่อยู่ใน use-case-curl.md ถูก revoke แล้ว ใช้ไม่ได้

### คน

| บทบาท | อีเมล (`X-Acting-User`) | `id` | role |
|---|---|---|---|
| ผู้ขอ (HRD) | `panitees@osd.co.th` | `303564ef-18a0-4187-80c1-15f30eedd034` | employee, receiver |
| ผู้ขอสำรอง (HRD) | `thanatchak@osd.co.th` | `16ca041f-6597-4576-9e04-350748be2779` | employee, receiver |
| ผู้รับ + ผู้อนุมัติ | `orasak@osd.co.th` | `fb8f9785-f550-4962-8121-f1b1667ec072` | admin, ceo |

ส่ง HR-S-001 ได้เฉพาะคนในหน่วย `OSD-OU0012` HRD

```bash
export BASE=http://192.168.31.52:3503/api/v1   # external-service UAT
export RFK_KEY=rfk_...                          # key aiyara หรือ all
export RUN=$(date +%Y%m%d%H%M)                  # ต่อท้าย Idempotency-Key ให้แต่ละรอบไม่ซ้ำ
export REQUEST_NO=                              # เอา request_no จากคำตอบของ 02 มาใส่
```

`Idempotency-Key` ใส่เฉพาะขั้นที่เปลี่ยนสถานะ ยิงซ้ำด้วย key เดิมได้คำตอบเดิม ไม่ได้ใบที่สอง
ถ้าไม่ใส่แล้วเน็ตหลุดยิงซ้ำ จะได้คำขอสองใบ

## 1. ลำดับ

| ขั้น | ใคร | ทำอะไร | สถานะหลังทำ |
|---|---|---|---|
| 01–02 | panitees | ดูฟอร์ม · ยื่น | `submitted` |
| 03–05 | orasak | หางานในคิว · ถามปุ่ม · รับเรื่อง | `in_progress` |
| 06 | orasak | ส่งงาน | `pending_approval` |
| 07–08 | orasak | หาใบที่รออนุมัติ · อนุมัติ | `approved` |
| 09–10 | panitees | ถามปุ่ม · ปิด | `closed` |
| N1 | tawankornw (BSD) | คนนอก HRD มองไม่เห็น type นี้ | — |

## 2. ขั้นตอน

### 01-form

ทำในนาม: panitees · ผลที่ควรได้: **200 · บังคับ 9 ช่อง label_th … details_th**

```bash
curl -s "$BASE/request/request-types/HR-S-001/form" \
  -H "Authorization: Bearer $RFK_KEY" \
  -H "X-Acting-User: panitees@osd.co.th"
```

### 02-create

ทำในนาม: panitees · ผลที่ควรได้: **201 · status = submitted · ได้ request_no**

> ไม่ต้องส่ง `receiver_user_id` เพราะ type ตั้งผู้รับประจำเป็น orasak ไว้แล้ว

```bash
curl -s -X POST "$BASE/request/requests" \
  -H "Authorization: Bearer $RFK_KEY" \
  -H "X-Acting-User: panitees@osd.co.th" \
  -H "Idempotency-Key: hr-s-001-$RUN-create" \
  -H "Content-Type: application/json" \
  -d '{
    "type_code": "HR-S-001",
    "form_data": {
      "label_th": "Engineering",
      "label_en": "Engineering",
      "title_th": "Software Engineer (Full-stack)",
      "title_en": "Software Engineer (Full-stack)",
      "body_th": "พัฒนาเว็บแอปพลิเคชันทั้งฝั่ง Frontend และ Backend ตั้งแต่ออกแบบจนถึงส่งมอบ",
      "body_en": "Build web applications end to end, from design to delivery.",
      "footnote_th": "งานประจำ · กรุงเทพฯ",
      "footnote_en": "Full-time · Bangkok",
      "details_th": "# หน้าที่ความรับผิดชอบ\n- พัฒนาและดูแลระบบทั้ง Frontend และ Backend\n- ออกแบบ API และฐานข้อมูล\n- ทำ code review และเขียน test\n# คุณสมบัติ\n- ประสบการณ์ 2 ปีขึ้นไป\n- ใช้ TypeScript, React และ Node.js ได้ดี\n- เข้าใจ SQL และการออกแบบระบบ"
    }
  }'
```

### 03-search-incoming

ทำในนาม: orasak · ผลที่ควรได้: **200 · มีใบจาก 02 และ available_actions มี receive**

```bash
curl -s "$BASE/request/requests?view=incoming&status=submitted" \
  -H "Authorization: Bearer $RFK_KEY" \
  -H "X-Acting-User: orasak@osd.co.th"
```

### 04-actions-receiver

ทำในนาม: orasak · ผลที่ควรได้: **200 · มี receive**

```bash
curl -s "$BASE/request/requests/$REQUEST_NO/actions" \
  -H "Authorization: Bearer $RFK_KEY" \
  -H "X-Acting-User: orasak@osd.co.th"
```

### 05-receive

ทำในนาม: orasak · ผลที่ควรได้: **201 · status = in_progress** (SLA เริ่มนับที่นี่)

```bash
curl -s -X POST "$BASE/request/requests/$REQUEST_NO/actions/receive" \
  -H "Authorization: Bearer $RFK_KEY" \
  -H "X-Acting-User: orasak@osd.co.th" \
  -H "Idempotency-Key: hr-s-001-$RUN-receive" \
  -H "Content-Type: application/json" \
  -d '{}'
```

### 06-complete

ทำในนาม: orasak · ผลที่ควรได้: **201 · status = pending_approval**

> `receiver_form_data` คือฟอร์มผู้รับ มีช่องเดียวคือ `note` ไม่บังคับ

```bash
curl -s -X POST "$BASE/request/requests/$REQUEST_NO/actions/complete" \
  -H "Authorization: Bearer $RFK_KEY" \
  -H "X-Acting-User: orasak@osd.co.th" \
  -H "Idempotency-Key: hr-s-001-$RUN-complete" \
  -H "Content-Type: application/json" \
  -d '{"receiver_form_data": {"note": "ตรวจข้อความประกาศแล้ว พร้อมเผยแพร่"}}'
```

### 07-search-awaiting

ทำในนาม: orasak · ผลที่ควรได้: **200 · มีใบจาก 02 รอ orasak อนุมัติ**

```bash
curl -s "$BASE/request/requests?view=awaiting" \
  -H "Authorization: Bearer $RFK_KEY" \
  -H "X-Acting-User: orasak@osd.co.th"
```

### 08-approve

ทำในนาม: orasak · ผลที่ควรได้: **201 · คืนเคสอนุมัติ (ไม่ใช่คำขอ) status = approved · คำขอเป็น approved**

> `note` บังคับ ส่งว่างได้ 400 `VALIDATION_FAILED` ถ้าไม่อนุมัติ ใช้ `reject` หรือ `send_back` (คืนไป `in_progress`) โดยส่ง body แบบเดียวกัน

```bash
curl -s -X POST "$BASE/request/requests/$REQUEST_NO/actions/approve" \
  -H "Authorization: Bearer $RFK_KEY" \
  -H "X-Acting-User: orasak@osd.co.th" \
  -H "Idempotency-Key: hr-s-001-$RUN-approve" \
  -H "Content-Type: application/json" \
  -d '{"note": "อนุมัติประกาศรับสมัครตำแหน่ง Software Engineer"}'
```

### 09-actions-requester

ทำในนาม: panitees · ผลที่ควรได้: **200 · มี close**

```bash
curl -s "$BASE/request/requests/$REQUEST_NO/actions" \
  -H "Authorization: Bearer $RFK_KEY" \
  -H "X-Acting-User: panitees@osd.co.th"
```

### 10-close

ทำในนาม: panitees · ผลที่ควรได้: **201 · status = closed** (ผู้ขอเท่านั้นที่ปิดได้, `note` ไม่บังคับ)

```bash
curl -s -X POST "$BASE/request/requests/$REQUEST_NO/actions/close" \
  -H "Authorization: Bearer $RFK_KEY" \
  -H "X-Acting-User: panitees@osd.co.th" \
  -H "Idempotency-Key: hr-s-001-$RUN-close" \
  -H "Content-Type: application/json" \
  -d '{"note": "ได้รับอนุมัติแล้ว ปิดเรื่อง"}'
```

### N1-not-hrd

ทำในนาม: tawankornw (BSD) · ผลที่ควรได้: **200 · ไม่มี HR-S-001 ในรายการ**

```bash
curl -s "$BASE/request/request-types?q=HR-S-001" \
  -H "Authorization: Bearer $RFK_KEY" \
  -H "X-Acting-User: tawankornw@osd.co.th"
```

## 3. response ที่จะได้

**HR-S-001 ยังไม่มีใครยิงจริง** รูปร่างข้างล่างมาจากผลยิงจริงของ BS-01 / FI06 (28 ต.ค. 2569,
[uat-request-open-api-keycloak/](./uat-request-open-api-keycloak/) · [uat-disbursement-open-api/](./uat-disbursement-open-api/))
ผ่าน route เดียวกัน เปลี่ยนค่าเป็นของ HR-S-001 · `<…>` = ค่าที่ได้ตอนยิง · `…` = ตัดออกเพื่อให้สั้น

มี response อยู่ 4 แบบ

| แบบ | ขั้น | หน้าตา |
|---|---|---|
| A ฟอร์ม | 01 | ค่าตั้งของ type |
| B คำขอเต็มใบ | 02, 05, 06, 10 | แถว `requests` (camelCase) — 02 มี relation ติดมาด้วย (`requester`, `receiver`, `slaClock`, `events` …) ส่วน 05/06/10 มีแค่ฟิลด์ของแถว |
| C ปุ่มที่กดได้ | 04, 09 | `actions` ของคนที่ยิง ณ สถานะนั้น |
| D รายการ | 03, 07, N1 | `{ data, page, page_size, total }` |
| E เคสอนุมัติ | 08 | เคส ไม่ใช่คำขอ |

### 01 · 200 (A)

```json
{
  "code": "HR-S-001",
  "name": "HR Request Careers",
  "sla_hours": null,
  "ref_required": false,
  "form_schema": { "type": "object", "required": ["label_th", "label_en", "title_th", "title_en", "body_th", "body_en", "footnote_th", "footnote_en", "details_th"], "properties": { … } },
  "receiver_form_schema": { "type": "object", "required": [], "properties": { "note": { … } } },
  "required_docs": [],
  "return_reason_codes": [{ "code": "INFO_INCOMPLETE", "name": "ข้อมูลไม่ครบ" }, { "code": "OTHER", "name": "อื่น ๆ (ระบุ)" }],
  "form_fields": [ … ],
  "receiver_form_fields": [ … ],
  "receiver_org_unit": null,
  "receiver_candidates": [ … ]
}
```

### 02 · 201 (B) — เก็บ `requestNo` ไว้ใส่ `$REQUEST_NO`

```json
{
  "id": "<uuid>",
  "requestNo": "REQ-OSD-HR-S-001-<YYMM><ลำดับ 4 หลัก>",
  "typeCode": "HR-S-001",
  "requesterId": "303564ef-18a0-4187-80c1-15f30eedd034",
  "receiverUserId": "fb8f9785-f550-4962-8121-f1b1667ec072",
  "assigneeUserId": null,
  "status": "submitted",
  "formData": { "label_th": "Engineering", "title_th": "Software Engineer (Full-stack)", … },
  "receiverFormData": null,
  "submittedAt": "<เวลา>",
  "completedAt": null,
  "closedAt": null,
  "requester": { … }, "receiver": { … }, "slaClock": { … }, "approvalCases": [], "events": [ … ],
  …
}
```

### 03 · 200 (D)

```json
{
  "data": [
    { "requestNo": "<REQUEST_NO>", "typeCode": "HR-S-001", "status": "submitted", …,
      "available_actions": ["receive", "assign", "return", "comment"] }
  ],
  "page": 1, "page_size": 20, "total": 1
}
```

### 04 · 200 (C)

```json
{
  "request_id": "<uuid>",
  "request_no": "<REQUEST_NO>",
  "status": "submitted",
  "actions": [
    { "action": "receive", "fields": [] },
    { "action": "assign", "fields": [{ "name": "assignee_user_id", "required": true }] },
    { "action": "return", "fields": [{ "name": "reason_code", "required": true, "source": "return_reason" }, { "name": "note", "required": false }] },
    { "action": "comment", "fields": [{ "name": "body", "required": true }] }
  ],
  "flow_moves": null,
  "can_create_child": true
}
```

### 05 · 201 (B)

```json
{ "requestNo": "<REQUEST_NO>", "status": "in_progress", "receiverUserId": "fb8f9785-…", "dueAt": null, … }
```

`dueAt` เป็น null เพราะ type นี้ไม่ได้ตั้ง SLA

### 06 · 201 (B)

```json
{ "requestNo": "<REQUEST_NO>", "status": "pending_approval",
  "receiverFormData": { "note": "ตรวจข้อความประกาศแล้ว พร้อมเผยแพร่" }, "completedAt": "<เวลา>", … }
```

### 07 · 200 (D)

```json
{ "data": [{ "requestNo": "<REQUEST_NO>", "status": "pending_approval", …,
             "available_actions": ["approve", "reject", "send_back", "comment"] }],
  "page": 1, "page_size": 20, "total": 1 }
```

### 08 · 201 (E)

```json
{
  "id": "<uuid เคส>",
  "subjectType": "request:HR-S-001",
  "subjectId": "<REQUEST_NO>",
  "status": "approved",
  "currentStep": 1,
  "steps": [{ "stepNo": 1, "status": "approved", "approverUserId": "fb8f9785-f550-4962-8121-f1b1667ec072" }]
}
```

ถ้าจะดูสถานะของคำขอ ให้ยิง 09 หรือ `GET $BASE/request/requests/$REQUEST_NO` แล้วจะได้ `"status": "approved"`

### 09 · 200 (C)

```json
{
  "request_no": "<REQUEST_NO>",
  "status": "approved",
  "actions": [
    { "action": "cancel", "fields": [{ "name": "reason", "required": true }] },
    { "action": "close", "fields": [{ "name": "note", "required": false }] },
    { "action": "comment", "fields": [{ "name": "body", "required": true }] }
  ],
  "flow_moves": null,
  "can_create_child": true
}
```

### 10 · 201 (B)

```json
{ "requestNo": "<REQUEST_NO>", "status": "closed", "completedAt": "<เวลา 06>", "closedAt": "<เวลา>", … }
```

### N1 · 200 (D)

```json
{ "data": [], "page": 1, "page_size": 20, "total": 0 }
```

### error ที่อาจเจอ (ทุก error เป็น `{ code, message, details }`)

| เมื่อ | HTTP · `code` | `message` |
|---|---|---|
| ผู้ขอกด receive แทน orasak | 403 `FORBIDDEN` | รับเรื่องได้เฉพาะผู้ที่ถูกระบุเป็นผู้รับเรื่อง |
| 02 ส่ง `receiver_user_id` เป็นคนอื่น | 400 `VALIDATION_FAILED` | ประเภทคำขอนี้กำหนดผู้รับเรื่องไว้แล้ว เปลี่ยนไม่ได้ (`details: [{field: "receiver_user_id", reason: "fixed_by_type"}]`) |
| 08 ส่ง `note` ว่าง | 400 `VALIDATION_FAILED` | `details: [{field: "note", reason: "required"}]` |
| 08 ยิงตอนคำขอไม่ได้อยู่ `pending_approval` | 409 `REQ_STATE_INVALID` | คำขอนี้ไม่ได้อยู่ระหว่างรอการอนุมัติ |
| อีเมลใน `X-Acting-User` สะกดหรือตัวพิมพ์ไม่ตรง | 404 `NOT_FOUND` | (ไม่บอกสาเหตุ) |
| key ถูก revoke หรือผิด | 401 | — |

ถ้าผลจริงไม่ตรงกับข้างบน ให้จดสถานะ HTTP และ `code` ที่ได้กลับมา
