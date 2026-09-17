# ตัวอย่าง curl — BS-01 (เปิด SO) และ FI05 (เงินทดรองจ่าย)

copy วางรันได้เลย ทุก id และทุกอีเมลในไฟล์นี้เป็นของจริงจากฐานข้อมูล
`osd_request_form_v1` วางลง Postman ได้ด้วย **Import → Raw text**

สองใบนี้คู่กันเพราะเดินคนละเส้น — **BS-01 ไม่มี approval, FI05 มี** ใครลอกไปใช้กับ
type อื่นต้องเช็คก่อนว่า type นั้นมี matrix ไหม ไม่ใช่เดาจากชื่อ

| | 1. BS-01 เปิด SO | 2. FI05 Petty Cash |
|---|---|---|
| approval | **ไม่มี** (non approve flow) | `request:FI05:pre` v1 (approve flow) |
| หลังสร้าง | `submitted` | `pending_approval` |
| ผู้รับ | `BSD` | `FAC` บัญชีและการเงิน |
| SLA | 8 ชม. | 72 ชม. |
| `ref_required` | **`true`** ต้องส่ง `ref_type` + `ref_id` | `false` |

---

## 0. หัวที่ทุก request ต้องมี

```
Authorization: Bearer rfk_u6g-4MrmLuC-eQCISLLRckdXcmm4SD21M_eblLOJTIM
X-Acting-User: <อีเมลของคนที่ระบบทำแทน>
Content-Type: application/json
```

base URL ของ external-service คือ `http://192.168.31.52:3503/api/v1` ใส่ไว้เต็ม ๆ ใน
ทุกคำสั่งข้างล่างแล้ว ไม่ต้องตั้งตัวแปรก่อน

`X-Acting-User` ไม่ใช่ของเสริม — ขอบเขตการมองเห็น, `assertMayAct`, นาฬิกา SLA และ
timeline บันทึกเป็นชื่อคนใน header นี้ ขาดแล้วยิงไม่ผ่าน และ **อีเมลต้องตรงตัวพิมพ์
เป๊ะกับ `users.email`** ไม่มี fallback เป็น username ผิดแล้วได้ 404 ที่ไม่บอกสาเหตุ

### คนจริงที่ใช้ในไฟล์นี้

| บทบาท | อีเมล (`X-Acting-User`) | `id` (ใช้เป็น `receiver_user_id` / `assignee_user_id`) |
|---|---|---|
| ผู้ขอ / BSD | `tawankornw@osd.co.th` | `ef74f358-c19a-4b15-869b-7eb9c0e4f871` |
| ผู้รับ BSD | `nongnuchc@osd.co.th` | `d320b28b-8e5c-4c9d-ac8b-f9b426e92798` |
| ผู้ทำงาน BSD | `wanatpornj@osd.co.th` | `ccfe9efa-1e13-4c49-a993-78546bb27ee3` |
| ผู้รับ FAC (AP) | `jaruchins@osd.co.th` | `9e87e5d4-44f9-420d-8ed3-493265b9d4b2` |
| ผู้จัดการบัญชี | `benjakoonb@osd.co.th` | `d0c3a652-cdb8-4a6e-8f6b-6d4307d4d278` |
| CFO | `thunvisits@osd.co.th` | `234529ec-c6a9-4f5e-aee3-f9d8b226a917` |

`receiver_user_id` รับ **uuid เท่านั้น** ส่งอีเมลหรือชื่อไปถูกปฏิเสธ

---

# 1. เปิด SO — BS-01 (non approve flow)

`submitted → in_progress → completed → approved → closed` ไม่แตะ `pending_approval` เลย

## 1.1 ดู request type ที่เปิดได้

```bash
curl -s "http://192.168.31.52:3503/api/v1/request/request-types?q=SO" \
  -H 'Authorization: Bearer rfk_u6g-4MrmLuC-eQCISLLRckdXcmm4SD21M_eblLOJTIM' \
  -H 'X-Acting-User: tawankornw@osd.co.th'
```

ผลจริง:

```json
[{"code":"BS-01","name":"ขอเปิด Sales Order (SO)","sla_hours":8,
  "receiver_org_unit":{"id":"b122758c-86a5-41d5-958e-1e955d023f51","name":"BSD"},
  "ref_required":true}]
```

## 1.2 ดูฟอร์ม

```bash
curl -s "http://192.168.31.52:3503/api/v1/request/request-types/BS-01/form" \
  -H 'Authorization: Bearer rfk_u6g-4MrmLuC-eQCISLLRckdXcmm4SD21M_eblLOJTIM' \
  -H 'X-Acting-User: tawankornw@osd.co.th'
```

บังคับ 6 ฟิลด์: `subject`, `objective`, `customer_name`, `priority`,
`source_channel`, `project_name`

`priority` รับเฉพาะ `LOW` `NORMAL` `HIGH` `URGENT`
`source_channel` รับเฉพาะ `EMAIL` `LINE` `PAPER` `VERBAL` `MEETING` `SYSTEM` `FORM`

**`ref_required: true` คือกับดักของ type นี้** — `ref_id` ไม่ได้อยู่ใน `form_data`
แต่เป็นคอลัมน์ของตัวคำขอ กรอกฟอร์มครบแต่ลืม `ref_id` ยังได้ `422 REQ_FIELD_MISSING`
ที่ field `ref_id` และข้อความจะไม่พูดถึงฟอร์มเลย

## 1.3 หา `receiver_user_id`

```bash
curl -s "http://192.168.31.52:3503/api/v1/request/users?q=นงนุช&page_size=5" \
  -H 'Authorization: Bearer rfk_u6g-4MrmLuC-eQCISLLRckdXcmm4SD21M_eblLOJTIM' \
  -H 'X-Acting-User: tawankornw@osd.co.th'
```

## 1.4 เปิดคำขอ

```bash
curl -s -X POST "http://192.168.31.52:3503/api/v1/request/requests" \
  -H 'Authorization: Bearer rfk_u6g-4MrmLuC-eQCISLLRckdXcmm4SD21M_eblLOJTIM' \
  -H 'X-Acting-User: tawankornw@osd.co.th' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: 8f3c1e90-5b47-4a2d-9c11-6d0f7a25e4b3' \
  -d '{
    "type_code": "BS-01",
    "receiver_user_id": "d320b28b-8e5c-4c9d-ac8b-f9b426e92798",
    "ref_type": "opportunity",
    "ref_id": "OPP-2026-0188",
    "form_data": {
      "subject": "ขอเปิด SO ระบบ CCTV อาคาร A — บจก. สยามรีเทล",
      "objective": "ลูกค้ายืนยันใบเสนอราคา QT-2026-0451 แล้ว ขอเปิด SO เพื่อสั่งของและตั้งทีมติดตั้ง",
      "requirement_detail": "กล้อง IP 48 ตัว, NVR 2 เครื่อง, ติดตั้งและเดินสายครบชุด",
      "expected_outcome": "เลขที่ SO สำหรับอ้างอิงในการสั่งซื้อและวางบิล",
      "customer_name": "บริษัท สยามรีเทล จำกัด",
      "project_name": "CCTV Upgrade อาคาร A",
      "cost_center": "BSD-1001",
      "amount": 1850000,
      "priority": "HIGH",
      "source_channel": "EMAIL",
      "needed_by_date": "2026-09-22",
      "is_backfill": "N",
      "remark": "ลูกค้าขอเริ่มติดตั้งต้นเดือนหน้า"
    }
  }'
```

**ส่ง `Idempotency-Key` ทุกครั้ง** ถ้า response หายกลางทางแล้วยิงซ้ำโดยไม่มี key
จะได้คำขอสองใบคนละเลขที่ กินเลขเอกสารไปฟรีหนึ่งใบและ merge คืนไม่ได้

ไม่มี matrix จึงได้ `"status": "submitted"` ทันที

**เลขที่ `REQ-OSD-BS01-26090035` ในคำสั่งข้างล่างเป็นตัวอย่างรูปแบบ** เลขจริงออกตอน
สร้างสำเร็จ เอา `request_no` จาก response นี้ไปแทนใน URL ของทุกขั้นถัดไป

## 1.5 ถามว่าตอนนี้ทำอะไรได้

```bash
curl -s "http://192.168.31.52:3503/api/v1/request/requests/REQ-OSD-BS01-26090035/actions" \
  -H 'Authorization: Bearer rfk_u6g-4MrmLuC-eQCISLLRckdXcmm4SD21M_eblLOJTIM' \
  -H 'X-Acting-User: nongnuchc@osd.co.th'
```

**ถามก่อนเสนอตัวเลือกเสมอ** คำตอบเปลี่ยนตามสถานะ *และ* ตามคนใน `X-Acting-User` —
ผู้ขอกับผู้รับถามใบเดียวกันได้คนละรายการ อย่า hardcode

## 1.6 ผู้รับกดรับเรื่อง

```bash
curl -s -X POST "http://192.168.31.52:3503/api/v1/request/requests/REQ-OSD-BS01-26090035/actions/receive" \
  -H 'Authorization: Bearer rfk_u6g-4MrmLuC-eQCISLLRckdXcmm4SD21M_eblLOJTIM' \
  -H 'X-Acting-User: nongnuchc@osd.co.th' \
  -H 'Content-Type: application/json' \
  -d '{}'
```

`receive` ทำได้เฉพาะ **ผู้รับที่ถูกระบุชื่อ** เท่านั้น การรับเรื่องมอบต่อกันไม่ได้
นาฬิกา SLA เริ่มนับจริงตรงนี้ ไม่ใช่ตอนสร้าง — ช่วงรอผู้รับกดรับไม่ถูกนับเป็นเวลา
ทำงานของทีมปลายทาง

## 1.7 มอบหมายให้คนทำ

```bash
curl -s -X POST "http://192.168.31.52:3503/api/v1/request/requests/REQ-OSD-BS01-26090035/actions/assign" \
  -H 'Authorization: Bearer rfk_u6g-4MrmLuC-eQCISLLRckdXcmm4SD21M_eblLOJTIM' \
  -H 'X-Acting-User: nongnuchc@osd.co.th' \
  -H 'Content-Type: application/json' \
  -d '{ "assignee_user_id": "ccfe9efa-1e13-4c49-a993-78546bb27ee3" }'
```

## 1.8 คอมเมนต์

```bash
curl -s -X POST "http://192.168.31.52:3503/api/v1/request/requests/REQ-OSD-BS01-26090035/actions/comment" \
  -H 'Authorization: Bearer rfk_u6g-4MrmLuC-eQCISLLRckdXcmm4SD21M_eblLOJTIM' \
  -H 'X-Acting-User: wanatpornj@osd.co.th' \
  -H 'Content-Type: application/json' \
  -d '{ "body": "ตรวจใบเสนอราคาแล้ว กำลังเปิด SO ในระบบ" }'
```

action นี้คืน comment ที่เพิ่งเขียน ไม่ใช่ตัวคำขอ จึงไม่มี `status` ให้อ่าน

## 1.9 พักงานระหว่างรอ vendor

```bash
curl -s -X POST "http://192.168.31.52:3503/api/v1/request/requests/REQ-OSD-BS01-26090035/actions/hold" \
  -H 'Authorization: Bearer rfk_u6g-4MrmLuC-eQCISLLRckdXcmm4SD21M_eblLOJTIM' \
  -H 'X-Acting-User: wanatpornj@osd.co.th' \
  -H 'Content-Type: application/json' \
  -d '{ "reason": "รอยืนยัน lead time กล้องจาก vendor" }'
```

```bash
curl -s -X POST "http://192.168.31.52:3503/api/v1/request/requests/REQ-OSD-BS01-26090035/actions/resume" \
  -H 'Authorization: Bearer rfk_u6g-4MrmLuC-eQCISLLRckdXcmm4SD21M_eblLOJTIM' \
  -H 'X-Acting-User: wanatpornj@osd.co.th' \
  -H 'Content-Type: application/json' \
  -d '{ "note": "vendor ยืนยัน 10 วันทำการ" }'
```

**`hold` / `cancel` ใช้ `reason` ส่วน `approve` / `reject` / `send_back` ใช้ `note`**
สลับกันแล้วได้ validation error ที่ไม่บอกว่าสลับฟิลด์ `on_hold` หยุดนาฬิกา SLA

## 1.10 แตกใบลูก

**ไม่มี action `create_child`** — ใบลูกคือคำขอธรรมดาที่มี `parent_request_id` จึงยิงที่
`POST /request/requests` เหมือนเปิดใบใหม่ และค่านั้นต้องเป็น **uuid ของใบแม่
ไม่ใช่เลขที่เอกสาร**

```bash
curl -s -X POST "http://192.168.31.52:3503/api/v1/request/requests" \
  -H 'Authorization: Bearer rfk_u6g-4MrmLuC-eQCISLLRckdXcmm4SD21M_eblLOJTIM' \
  -H 'X-Acting-User: wanatpornj@osd.co.th' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: c1a7d248-93f6-4b0e-8a5c-2e41b9f7d60a' \
  -d '{
    "type_code": "FI05",
    "receiver_user_id": "9e87e5d4-44f9-420d-8ed3-493265b9d4b2",
    "parent_request_id": "f7f7609e-9317-454e-875d-ec543bc4caf0",
    "form_data": {
      "requester_department": "Business Solution",
      "cost_center": "BSD-1001",
      "payee": "นางสาววณัฐพร จำรัสเลิศลักษณ์",
      "needed_by": "2026-09-28",
      "clear_by": "2026-10-15",
      "purpose": "เงินทดรองสำรวจหน้างานก่อนเปิด SO",
      "so_no": "SO-2026-0417",
      "expense_items": [
        { "description": "ค่าเดินทางสำรวจหน้างาน", "cost_center": "BSD-1001", "amount": 3200 }
      ]
    }
  }'
```

ดูทั้งสายด้วย `tree` — **ใบแม่ปิดไม่ได้ถ้าใบลูกยังไม่จบ**

```bash
curl -s "http://192.168.31.52:3503/api/v1/request/requests/REQ-OSD-BS01-26090035/tree" \
  -H 'Authorization: Bearer rfk_u6g-4MrmLuC-eQCISLLRckdXcmm4SD21M_eblLOJTIM' \
  -H 'X-Acting-User: tawankornw@osd.co.th'
```

## 1.11 ปิดงาน

`receiver_form_data` เป็น **คนละฟอร์ม** กับตอนเปิดคำขอ ของ BS-01 มีช่องเดียวและ
`required` ว่าง ส่ง `{}` ก็ผ่าน แต่ `summary` คือสิ่งที่ผู้ขอจะได้อ่าน

```bash
curl -s -X POST "http://192.168.31.52:3503/api/v1/request/requests/REQ-OSD-BS01-26090035/actions/complete" \
  -H 'Authorization: Bearer rfk_u6g-4MrmLuC-eQCISLLRckdXcmm4SD21M_eblLOJTIM' \
  -H 'X-Acting-User: wanatpornj@osd.co.th' \
  -H 'Content-Type: application/json' \
  -d '{ "receiver_form_data": { "summary": "เปิด SO-2026-0417 เรียบร้อย ส่งเข้าระบบจัดซื้อแล้ว" } }'
```

ไม่มี matrix ⇒ `complete` พาไป `approved` ตรง ๆ ไม่แวะ `pending_approval`

## 1.12 ผู้ขอปิดใบ

```bash
curl -s -X POST "http://192.168.31.52:3503/api/v1/request/requests/REQ-OSD-BS01-26090035/actions/close" \
  -H 'Authorization: Bearer rfk_u6g-4MrmLuC-eQCISLLRckdXcmm4SD21M_eblLOJTIM' \
  -H 'X-Acting-User: tawankornw@osd.co.th' \
  -H 'Content-Type: application/json' \
  -d '{ "note": "ได้เลข SO แล้ว ปิดเรื่อง" }'
```

**ผู้ขอเท่านั้น** ที่ปิดใบได้ และปิดได้หลังผลงานถูกยอมรับแล้วเท่านั้น

---

# 2. Petty Cash — FI05 (approve flow)

`pending_approval → submitted → in_progress → completed → approved → closed`

ต่างจาก BS-01 ตรงที่มี matrix `request:FI05:pre` v1 (`department_manager`) คั่นอยู่
**ก่อน** บัญชีจะเห็นงาน

## 2.1 ดู request type

```bash
curl -s "http://192.168.31.52:3503/api/v1/request/request-types?q=ทดรอง" \
  -H 'Authorization: Bearer rfk_u6g-4MrmLuC-eQCISLLRckdXcmm4SD21M_eblLOJTIM' \
  -H 'X-Acting-User: tawankornw@osd.co.th'
```

## 2.2 ดูฟอร์ม

```bash
curl -s "http://192.168.31.52:3503/api/v1/request/request-types/FI05/form" \
  -H 'Authorization: Bearer rfk_u6g-4MrmLuC-eQCISLLRckdXcmm4SD21M_eblLOJTIM' \
  -H 'X-Acting-User: tawankornw@osd.co.th'
```

บังคับ 7 ฟิลด์: `requester_department`, `cost_center`, `payee`, `needed_by`,
`clear_by`, `purpose`, `expense_items`

บล็อก SO (`so_no`, `so_subject`), `ticket_no`, `project_code` เป็นของเสริม
ใส่ตอนเงินก้อนนี้ผูกกับดีล — **ไม่ใช่** `ref_type`/`ref_id` เพราะหน้าจอมีอ้างอิงสี่ตัว
แต่คอลัมน์คู่นั้นเก็บได้ตัวเดียว

## 2.3 เปิดคำขอ

```bash
curl -s -X POST "http://192.168.31.52:3503/api/v1/request/requests" \
  -H 'Authorization: Bearer rfk_u6g-4MrmLuC-eQCISLLRckdXcmm4SD21M_eblLOJTIM' \
  -H 'X-Acting-User: tawankornw@osd.co.th' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: 4d92b6f1-7c38-4e59-b0a3-15fe8c47d902' \
  -d '{
    "type_code": "FI05",
    "receiver_user_id": "9e87e5d4-44f9-420d-8ed3-493265b9d4b2",
    "form_data": {
      "requester_department": "Business Solution",
      "cost_center": "BSD-1001",
      "payee": "นางธวัลกร วงศ์ประเทศ",
      "needed_by": "2026-09-25",
      "clear_by": "2026-10-10",
      "purpose": "ค่าเดินทางและที่พักติดตั้งระบบ CCTV ที่ไซต์ลูกค้า จ.ระยอง 3 วัน",
      "remark": "เบิกล่วงหน้า เคลียร์ตามใบเสร็จจริงหลังกลับ",
      "so_no": "SO-2026-0417",
      "so_subject": "ติดตั้งระบบ CCTV อาคาร A",
      "project_code": "PRJ-CCTV-RY",
      "expense_items": [
        { "description": "ค่าเดินทาง (น้ำมัน + ทางด่วน)", "cost_center": "BSD-1001", "amount": 4500 },
        { "description": "ค่าที่พัก 3 คืน", "cost_center": "BSD-1001", "amount": 5400, "note": "2 คน" },
        { "description": "เบี้ยเลี้ยง", "cost_center": "BSD-1001", "amount": 2100 }
      ]
    }
  }'
```

ได้ `"status": "pending_approval"` **ไม่ใช่ `submitted`** — นี่คือจุดที่ต่างจาก BS-01

`REQ-OSD-FI05-26090012` ข้างล่างก็เป็นตัวอย่างรูปแบบเช่นกัน — แทนด้วย `request_no`
ที่ได้จริงจาก response นี้

## 2.4 ดูว่ารออนุมัติที่ใคร

```bash
curl -s "http://192.168.31.52:3503/api/v1/request/requests/REQ-OSD-FI05-26090012" \
  -H 'Authorization: Bearer rfk_u6g-4MrmLuC-eQCISLLRckdXcmm4SD21M_eblLOJTIM' \
  -H 'X-Acting-User: tawankornw@osd.co.th'
```

```bash
curl -s "http://192.168.31.52:3503/api/v1/request/requests?view=awaiting" \
  -H 'Authorization: Bearer rfk_u6g-4MrmLuC-eQCISLLRckdXcmm4SD21M_eblLOJTIM' \
  -H 'X-Acting-User: benjakoonb@osd.co.th'
```

`view=approver` แปลว่า "มีชื่ออยู่ในบันได" ซึ่งกว้างกว่า — คนชั้น 3 เห็นใบที่ยังไต่
อยู่ชั้น 2 ด้วย ถ้าต้องการเฉพาะที่รอตัวเองจริง ๆ ใช้ `view=awaiting`

## 2.5 หัวหน้าอนุมัติ

```bash
curl -s -X POST "http://192.168.31.52:3503/api/v1/request/requests/REQ-OSD-FI05-26090012/actions/approve" \
  -H 'Authorization: Bearer rfk_u6g-4MrmLuC-eQCISLLRckdXcmm4SD21M_eblLOJTIM' \
  -H 'X-Acting-User: benjakoonb@osd.co.th' \
  -H 'Content-Type: application/json' \
  -d '{ "note": "งบ cost center BSD-1001 เหลือพอ อนุมัติ" }'
```

**`note` บังคับ** สำหรับ `approve` / `reject` / `send_back` ส่งว่างหรือเว้นวรรคล้วน
ได้ `400 VALIDATION_FAILED` (field `note`, reason `required`)

อนุมัติแล้วไป `submitted` คือ **เพิ่งจะถึงมือบัญชี ไม่ใช่จบงาน**

## 2.6 หรือส่งกลับ / ปฏิเสธ

```bash
curl -s -X POST "http://192.168.31.52:3503/api/v1/request/requests/REQ-OSD-FI05-26090012/actions/send_back" \
  -H 'Authorization: Bearer rfk_u6g-4MrmLuC-eQCISLLRckdXcmm4SD21M_eblLOJTIM' \
  -H 'X-Acting-User: benjakoonb@osd.co.th' \
  -H 'Content-Type: application/json' \
  -d '{ "note": "ยอดเบี้ยเลี้ยงเกินเกณฑ์ ขอให้แก้แล้วส่งใหม่" }'
```

`send_back` **ที่ขั้นก่อนทำงาน** ส่งไป `returned` (คืนผู้ขอ เพราะยังไม่มีใครเริ่มทำ)
ต่างจาก `send_back` ของขั้นหลังทำงานที่คืนไป `in_progress` (คืนทีมที่ทำ)

```bash
curl -s -X POST "http://192.168.31.52:3503/api/v1/request/requests/REQ-OSD-FI05-26090012/actions/reject" \
  -H 'Authorization: Bearer rfk_u6g-4MrmLuC-eQCISLLRckdXcmm4SD21M_eblLOJTIM' \
  -H 'X-Acting-User: benjakoonb@osd.co.th' \
  -H 'Content-Type: application/json' \
  -d '{ "note": "ไตรมาสนี้ปิดงบเดินทางแล้ว" }'
```

`rejected` เป็นสถานะปลายทาง ไปต่อไม่ได้

## 2.7 บัญชีรับเรื่อง

```bash
curl -s -X POST "http://192.168.31.52:3503/api/v1/request/requests/REQ-OSD-FI05-26090012/actions/receive" \
  -H 'Authorization: Bearer rfk_u6g-4MrmLuC-eQCISLLRckdXcmm4SD21M_eblLOJTIM' \
  -H 'X-Acting-User: jaruchins@osd.co.th' \
  -H 'Content-Type: application/json' \
  -d '{}'
```

## 2.8 ตีกลับให้แก้ ถ้าเอกสารไม่ครบ

```bash
curl -s -X POST "http://192.168.31.52:3503/api/v1/request/requests/REQ-OSD-FI05-26090012/actions/return" \
  -H 'Authorization: Bearer rfk_u6g-4MrmLuC-eQCISLLRckdXcmm4SD21M_eblLOJTIM' \
  -H 'X-Acting-User: jaruchins@osd.co.th' \
  -H 'Content-Type: application/json' \
  -d '{ "reason_code": "COST_CENTER_INVALID", "note": "BSD-1001 ปิดงบไตรมาสนี้แล้ว" }'
```

`reason_code` ต้องเป็นรหัสจาก `return_reason_codes` ของ FI05 เท่านั้น รหัสนอกรายการ
ถูกปฏิเสธ (REQ-04 — รายการมีไว้ให้นับสาเหตุการตีกลับได้):

`INFO_INCOMPLETE` · `DOC_MISSING` · `COST_CENTER_INVALID` · `AMOUNT_EXCEEDS_LIMIT`
· `CLEAR_DATE_UNREALISTIC` · `OTHER`

## 2.9 ผู้ขอแก้แล้วส่งใหม่

```bash
curl -s -X POST "http://192.168.31.52:3503/api/v1/request/requests/REQ-OSD-FI05-26090012/actions/resubmit" \
  -H 'Authorization: Bearer rfk_u6g-4MrmLuC-eQCISLLRckdXcmm4SD21M_eblLOJTIM' \
  -H 'X-Acting-User: tawankornw@osd.co.th' \
  -H 'Content-Type: application/json' \
  -d '{
    "form_data": {
      "requester_department": "Business Solution",
      "cost_center": "BSD-2002",
      "payee": "นางธวัลกร วงศ์ประเทศ",
      "needed_by": "2026-09-25",
      "clear_by": "2026-10-10",
      "purpose": "ค่าเดินทางและที่พักติดตั้งระบบ CCTV ที่ไซต์ลูกค้า จ.ระยอง 3 วัน",
      "remark": "เปลี่ยน cost center ตามที่บัญชีแจ้ง",
      "so_no": "SO-2026-0417",
      "expense_items": [
        { "description": "ค่าเดินทาง (น้ำมัน + ทางด่วน)", "cost_center": "BSD-2002", "amount": 4500 },
        { "description": "ค่าที่พัก 3 คืน", "cost_center": "BSD-2002", "amount": 5400, "note": "2 คน" },
        { "description": "เบี้ยเลี้ยง", "cost_center": "BSD-2002", "amount": 2100 }
      ]
    }
  }'
```

**ต้องส่ง `form_data` ทั้งใบ** ระบบแทนที่ทั้งก้อนแล้วตรวจ required ใหม่หมด
ส่งมาเฉพาะฟิลด์ที่แก้จะได้ `REQ_FIELD_MISSING`

`resubmit` **เข้าขั้นอนุมัติใหม่อีกรอบ** — ใบที่เคยอนุมัติไม่ใช่ใบที่กำลังส่งอยู่นี้

## 2.10 บัญชีปิดงาน

```bash
curl -s -X POST "http://192.168.31.52:3503/api/v1/request/requests/REQ-OSD-FI05-26090012/actions/complete" \
  -H 'Authorization: Bearer rfk_u6g-4MrmLuC-eQCISLLRckdXcmm4SD21M_eblLOJTIM' \
  -H 'X-Acting-User: jaruchins@osd.co.th' \
  -H 'Content-Type: application/json' \
  -d '{
    "receiver_form_data": {
      "checked_cost_center": true,
      "checked_documents": true,
      "checked_authority": true,
      "note": "โอนเงินเข้าบัญชีผู้รับแล้ว 12,000 บาท กำหนดเคลียร์ 10 ต.ค. 2569"
    }
  }'
```

**ติ๊กสามข้อบังคับให้ *มีค่า* แต่บังคับให้ *เป็น true* ไม่ได้** — `false` นับว่าตอบแล้ว
และผ่าน validation ความจริงของแต่ละติ๊กคือคำให้การของบัญชี ไม่มี schema ไหนตรวจได้

FI05 ไม่มี matrix ขั้นหลังทำงาน (มีแต่ `:pre`) `complete` จึงพาไป `approved` ตรง ๆ

## 2.11 ผู้ขอปิดใบ

```bash
curl -s -X POST "http://192.168.31.52:3503/api/v1/request/requests/REQ-OSD-FI05-26090012/actions/close" \
  -H 'Authorization: Bearer rfk_u6g-4MrmLuC-eQCISLLRckdXcmm4SD21M_eblLOJTIM' \
  -H 'X-Acting-User: tawankornw@osd.co.th' \
  -H 'Content-Type: application/json' \
  -d '{ "note": "ได้รับเงินแล้ว" }'
```

---

# 3. ติดตามงาน

```bash
# คิวที่เข้ามาหาฉัน
curl -s "http://192.168.31.52:3503/api/v1/request/requests?view=incoming&status=submitted&page_size=20" \
  -H 'Authorization: Bearer rfk_u6g-4MrmLuC-eQCISLLRckdXcmm4SD21M_eblLOJTIM' \
  -H 'X-Acting-User: jaruchins@osd.co.th'

# ใบที่ฉันเปิดเอง
curl -s "http://192.168.31.52:3503/api/v1/request/requests?view=created&type_code=FI05" \
  -H 'Authorization: Bearer rfk_u6g-4MrmLuC-eQCISLLRckdXcmm4SD21M_eblLOJTIM' \
  -H 'X-Acting-User: tawankornw@osd.co.th'

# เฉพาะที่เกิน SLA
curl -s "http://192.168.31.52:3503/api/v1/request/requests?view=involved&overdue=true" \
  -H 'Authorization: Bearer rfk_u6g-4MrmLuC-eQCISLLRckdXcmm4SD21M_eblLOJTIM' \
  -H 'X-Acting-User: tawankornw@osd.co.th'

# นับแยกสถานะ — ตัวเลขตรงกับรายการข้างบนเสมอ เพราะใช้เงื่อนไขชุดเดียวกัน
curl -s "http://192.168.31.52:3503/api/v1/request/requests/summary?view=involved" \
  -H 'Authorization: Bearer rfk_u6g-4MrmLuC-eQCISLLRckdXcmm4SD21M_eblLOJTIM' \
  -H 'X-Acting-User: tawankornw@osd.co.th'
```

`status` ที่สะกดผิดได้ `400` ไม่ใช่หน้าว่าง — จงใจ เพราะหน้าว่างอ่านเป็น "ไม่มีงาน"
ซึ่งเป็นคำตอบที่ผิดที่สุดสำหรับบอทที่รายงานภาระงานของคน

---

# 4. error ที่เจอบ่อย

| ได้อะไร | แปลว่า |
|---|---|
| `422 REQ_FIELD_MISSING` field `ref_id` | ลืม `ref_type`/`ref_id` ของ BS-01 — ไม่เกี่ยวกับ `form_data` |
| `400 VALIDATION_FAILED` field `note` | `approve`/`reject`/`send_back` ไม่มี `note` หรือมีแต่ช่องว่าง |
| `REQ_FIELD_MISSING` หลัง `resubmit` | ส่ง `form_data` มาไม่ครบใบ — ต้องส่งทั้งก้อน |
| `403 FORBIDDEN` | service account ไม่มี realm role `integration.request.create` → `yarn keycloak:provision` |
| `404` ตั้งแต่ครั้งแรก | `X-Acting-User` ไม่ตรงกับ `users.email` แบบตัวพิมพ์เป๊ะ — 404 ไม่บอกสาเหตุนี้ |
| action ที่หวังไว้ไม่อยู่ใน `/actions` | สถานะหรือบทบาทไม่ตรง — อ่านคำตอบของ `/actions` อย่าเดา |
