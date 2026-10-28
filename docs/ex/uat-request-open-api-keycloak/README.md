# UAT คำขอทั่วไปผ่าน Open API · ระบุคนด้วย Keycloak (`X-User-Token`)

เดินคำขอทั่วไปหนึ่งใบตั้งแต่เปิดถึงปิด ใช้ `BS-01` ขอเปิด SO ซึ่งเป็น type ที่ไม่มี flow และไม่มีขั้นอนุมัติ
`submitted → in_progress → completed → approved → closed` ตาม [workflows/types/GENERAL.md](../../workflows/types/GENERAL.md)
ขั้นตอนและข้อมูลมาจาก [`use-case-curl.md` ข้อ 1](../use-case-curl.md) ต่างกันแค่วิธีระบุคน คือใช้ `X-User-Token` (access token ของคนนั้นจาก Keycloak realm `OSD`) แทน `X-Acting-User` (อีเมล)
มีขั้นค้นหาและเปิดดูเพิ่มเข้ามา (05–07, 15–16) เพื่อให้เห็นว่าแต่ละคนหางานของตัวเองเจออย่างไร
ไฟล์ `*.request.json` คือ request ของแต่ละขั้นในรูปแบบเดียวกับ [`uat-disbursement-open-api/`](../uat-disbursement-open-api/)

## 0. ก่อนเริ่ม

### หัวของทุก request

```
Authorization: Bearer <rfk_ key ของ integration>     ← ระบบภายนอกตัวไหน (สิทธิ์ = scopes ของ key)
X-User-Token: <access token ของคนที่ทำรายการ>          ← ทำในนามใคร (สิทธิ์ = สิทธิ์ของคนนั้น)
```

- ห้ามส่งคู่กับ `X-Acting-User` ถ้าส่งทั้งคู่ได้ 400 `VALIDATION_FAILED`
- ใส่ Keycloak token ใน `Authorization` แทน key ไม่ได้ เพราะ route ของ Open API รับเฉพาะบัญชีบริการ

### integration ต้องตั้งไว้แล้ว (หน้า ผู้ดูแลระบบ → ระบบภายนอก)

| ต้องมี | ถ้าไม่มี |
|---|---|
| เปิดโหมด "ในนามผู้ใช้" (`delegated`) | 403 `FORBIDDEN` "ระบบภายนอกนี้ไม่ได้เปิดให้ทำรายการในนามผู้ใช้" |
| client id ที่ออก token (`azp`) อยู่ในรายการ Keycloak client ของ integration | 403 `FORBIDDEN` "token ของผู้ใช้ไม่ได้ออกให้ระบบภายนอกนี้" |
| key มี scope ที่ขั้นนั้นใช้ เช่น `integration.request.read` · `integration.request.create` · `integration.request.complete` · `integration.request.hold` | 403 `FORBIDDEN` |
| key ผูกบริษัท OSD และทุกคนอยู่ใน OSD | 404 `NOT_FOUND` "ไม่พบผู้ใช้ในบริษัทของ API key นี้" |

ทุกคนใช้ token จาก realm `OSD` client เดียวกัน แต่**แต่ละคนใช้ token ของตัวเอง** เพราะระบบตัดสินสิทธิ์จากเจ้าของ token
ถ้า token มาจาก client `request-form` (client ของหน้าเว็บเรา) ต้องใส่ `request-form` ในรายการ client ของ integration ก่อน

### คนและตัวแปร

| บทบาท | คน | ตัวแปร | `id` |
|---|---|---|---|
| ผู้ขอ | `tawankornw@osd.co.th` | `TOKEN_REQUESTER` | `ef74f358-c19a-4b15-869b-7eb9c0e4f871` |
| ผู้รับ BSD | `nongnuchc@osd.co.th` | `TOKEN_RECEIVER` | `d320b28b-8e5c-4c9d-ac8b-f9b426e92798` |
| ผู้ทำ BSD | `wanatpornj@osd.co.th` | `TOKEN_WORKER` | `ccfe9efa-1e13-4c49-a993-78546bb27ee3` |

```bash
export BASE=http://192.168.31.52:3503/api/v1     # external-service (local: http://localhost:3003/api/v1)
export RFK_KEY=rfk_...                            # key ของ integration ที่เปิด delegated
export TOKEN_REQUESTER=eyJ...  TOKEN_RECEIVER=eyJ...  TOKEN_WORKER=eyJ...
export RUN=$(date +%Y%m%d%H%M)                    # ใช้ต่อท้าย Idempotency-Key ให้ไม่ซ้ำกันในแต่ละรอบ
export REQUEST_NO=                                # เอา request_no จากคำตอบของ 04 มาใส่
```

access token มีอายุสั้น ถ้าได้ 401 ให้ login ขอใหม่ ถ้าต้องการดูว่า token เป็นของใครและออกให้ client ไหน:

```bash
python3 -c "import sys,json,base64;p=sys.argv[1].split('.')[1];d=json.loads(base64.urlsafe_b64decode(p+'='*(-len(p)%4)));print(d.get('azp'),d.get('email'),d.get('exp'))" "$TOKEN_REQUESTER"
```

## 1. ลำดับ

| ขั้น | ใคร | ทำอะไร | สถานะหลังทำ |
|---|---|---|---|
| 01–04 | ผู้ขอ | ดู type · ดูฟอร์ม · หาผู้รับ · ยื่น | `submitted` |
| 05–08 | ผู้รับ | หางานในคิว · เปิดดู · ถามปุ่ม · รับเรื่อง | `in_progress` |
| 09–14 | ผู้รับ → ผู้ทำ | มอบหมาย · คอมเมนต์ · พัก / ทำต่อ · ส่งงาน | `approved` |
| 15–17 | ผู้ขอ | หาใบที่ยื่น · ถามปุ่ม · ปิด | `closed` |
| N1–N2 | — | กรณีที่ต้องถูกปฏิเสธ | ไม่เปลี่ยน |

ใบลูกไม่ได้รวมไว้ในชุดนี้ ใบลูกเปิดด้วย `POST request/requests` พร้อม `parent_request_id` (uuid ของใบแม่) ดูตัวอย่างใน `use-case-curl.md` ข้อ 1.10 ส่วนขั้น 13 ดูสายแม่ลูก

## 2. ขั้นตอน

### 01-request-types

ทำในนาม: ผู้ขอ (`$TOKEN_REQUESTER`) · ผลที่ควรได้: **200 · มี BS-01**

> ref_required = true ต้องส่ง ref_type + ref_id ตอนยื่น

```bash
curl -s -X GET "$BASE/request/request-types?q=SO" \
  -H "Authorization: Bearer $RFK_KEY" \
  -H "X-User-Token: $TOKEN_REQUESTER"
```

### 02-form

ทำในนาม: ผู้ขอ (`$TOKEN_REQUESTER`) · ผลที่ควรได้: **200 · บังคับ subject, objective, customer_name, priority, source_channel, project_name**

```bash
curl -s -X GET "$BASE/request/request-types/BS-01/form" \
  -H "Authorization: Bearer $RFK_KEY" \
  -H "X-User-Token: $TOKEN_REQUESTER"
```

### 03-users

ทำในนาม: ผู้ขอ (`$TOKEN_REQUESTER`) · ผลที่ควรได้: **200 · id ของผู้รับ = d320b28b-8e5c-4c9d-ac8b-f9b426e92798**

> receiver_user_id รับ uuid เท่านั้น

```bash
curl -s -X GET "$BASE/request/users?q=นงนุช&page_size=5" \
  -H "Authorization: Bearer $RFK_KEY" \
  -H "X-User-Token: $TOKEN_REQUESTER"
```

### 04-create

ทำในนาม: ผู้ขอ (`$TOKEN_REQUESTER`) · ผลที่ควรได้: **201 · status = submitted · ได้ request_no**

> ส่ง Idempotency-Key ทุกครั้ง ยิงซ้ำโดยไม่มี key จะได้สองใบ

```bash
curl -s -X POST "$BASE/request/requests" \
  -H "Authorization: Bearer $RFK_KEY" \
  -H "X-User-Token: $TOKEN_REQUESTER" \
  -H "Idempotency-Key: uat-bs01-$RUN-create" \
  -H "Content-Type: application/json" \
  -d '{"type_code": "BS-01", "receiver_user_id": "d320b28b-8e5c-4c9d-ac8b-f9b426e92798", "ref_type": "opportunity", "ref_id": "OPP-2026-0188", "form_data": {"subject": "ขอเปิด SO ระบบ CCTV อาคาร A — บจก. สยามรีเทล", "objective": "ลูกค้ายืนยันใบเสนอราคา QT-2026-0451 แล้ว ขอเปิด SO เพื่อสั่งของและตั้งทีมติดตั้ง", "requirement_detail": "กล้อง IP 48 ตัว, NVR 2 เครื่อง, ติดตั้งและเดินสายครบชุด", "expected_outcome": "เลขที่ SO สำหรับอ้างอิงในการสั่งซื้อและวางบิล", "customer_name": "บริษัท สยามรีเทล จำกัด", "project_name": "CCTV Upgrade อาคาร A", "cost_center": "BSD-1001", "amount": 1850000, "priority": "HIGH", "source_channel": "EMAIL", "needed_by_date": "2026-09-22", "is_backfill": "N", "remark": "ลูกค้าขอเริ่มติดตั้งต้นเดือนหน้า"}}'
```

### 05-search-incoming

ทำในนาม: ผู้รับ BSD (`$TOKEN_RECEIVER`) · ผลที่ควรได้: **200 · มีใบจาก 04 และแถวนั้นมี available_actions = ["receive", …]**

> ผู้รับหางานในคิว (ค้นหา)

```bash
curl -s -X GET "$BASE/request/requests?view=incoming&status=submitted" \
  -H "Authorization: Bearer $RFK_KEY" \
  -H "X-User-Token: $TOKEN_RECEIVER"
```

### 06-get-request

ทำในนาม: ผู้รับ BSD (`$TOKEN_RECEIVER`) · ผลที่ควรได้: **200 · status = submitted**

> เปิดดู

```bash
curl -s -X GET "$BASE/request/requests/$REQUEST_NO" \
  -H "Authorization: Bearer $RFK_KEY" \
  -H "X-User-Token: $TOKEN_RECEIVER"
```

### 07-actions-receiver

ทำในนาม: ผู้รับ BSD (`$TOKEN_RECEIVER`) · ผลที่ควรได้: **200 · มี receive พร้อม fields**

> ถามก่อนกดทุกครั้ง คำตอบขึ้นกับสถานะและเจ้าของ token

```bash
curl -s -X GET "$BASE/request/requests/$REQUEST_NO/actions" \
  -H "Authorization: Bearer $RFK_KEY" \
  -H "X-User-Token: $TOKEN_RECEIVER"
```

### 08-receive

ทำในนาม: ผู้รับ BSD (`$TOKEN_RECEIVER`) · ผลที่ควรได้: **201 · status = in_progress**

> ผู้รับที่ระบุชื่อเท่านั้น SLA เริ่มเดินที่นี่

```bash
curl -s -X POST "$BASE/request/requests/$REQUEST_NO/actions/receive" \
  -H "Authorization: Bearer $RFK_KEY" \
  -H "X-User-Token: $TOKEN_RECEIVER" \
  -H "Idempotency-Key: uat-bs01-$RUN-receive" \
  -H "Content-Type: application/json" \
  -d '{}'
```

### 09-assign

ทำในนาม: ผู้รับ BSD (`$TOKEN_RECEIVER`) · ผลที่ควรได้: **201 · assignee = ผู้ทำ**

```bash
curl -s -X POST "$BASE/request/requests/$REQUEST_NO/actions/assign" \
  -H "Authorization: Bearer $RFK_KEY" \
  -H "X-User-Token: $TOKEN_RECEIVER" \
  -H "Idempotency-Key: uat-bs01-$RUN-assign" \
  -H "Content-Type: application/json" \
  -d '{"assignee_user_id": "ccfe9efa-1e13-4c49-a993-78546bb27ee3"}'
```

### 10-comment

ทำในนาม: ผู้ทำ BSD (`$TOKEN_WORKER`) · ผลที่ควรได้: **201 · คืน comment ไม่ใช่คำขอ**

```bash
curl -s -X POST "$BASE/request/requests/$REQUEST_NO/actions/comment" \
  -H "Authorization: Bearer $RFK_KEY" \
  -H "X-User-Token: $TOKEN_WORKER" \
  -H "Content-Type: application/json" \
  -d '{"body": "ตรวจใบเสนอราคาแล้ว กำลังเปิด SO ในระบบ"}'
```

### 11-hold

ทำในนาม: ผู้ทำ BSD (`$TOKEN_WORKER`) · ผลที่ควรได้: **201 · status = on_hold (SLA หยุด)**

> hold / cancel ใช้ reason ส่วน approve / reject ใช้ note

```bash
curl -s -X POST "$BASE/request/requests/$REQUEST_NO/actions/hold" \
  -H "Authorization: Bearer $RFK_KEY" \
  -H "X-User-Token: $TOKEN_WORKER" \
  -H "Idempotency-Key: uat-bs01-$RUN-hold" \
  -H "Content-Type: application/json" \
  -d '{"reason": "รอยืนยัน lead time กล้องจาก vendor"}'
```

### 12-resume

ทำในนาม: ผู้ทำ BSD (`$TOKEN_WORKER`) · ผลที่ควรได้: **201 · status = in_progress**

```bash
curl -s -X POST "$BASE/request/requests/$REQUEST_NO/actions/resume" \
  -H "Authorization: Bearer $RFK_KEY" \
  -H "X-User-Token: $TOKEN_WORKER" \
  -H "Idempotency-Key: uat-bs01-$RUN-resume" \
  -H "Content-Type: application/json" \
  -d '{"note": "vendor ยืนยัน 10 วันทำการ"}'
```

### 13-tree

ทำในนาม: ผู้ขอ (`$TOKEN_REQUESTER`) · ผลที่ควรได้: **200 · สายคำขอแม่ลูก**

> ใบแม่ปิดไม่ได้ถ้าใบลูกยังไม่จบ

```bash
curl -s -X GET "$BASE/request/requests/$REQUEST_NO/tree" \
  -H "Authorization: Bearer $RFK_KEY" \
  -H "X-User-Token: $TOKEN_REQUESTER"
```

### 14-complete

ทำในนาม: ผู้ทำ BSD (`$TOKEN_WORKER`) · ผลที่ควรได้: **201 · status = approved (BS-01 ไม่มี matrix)**

> receiver_form_data เป็นฟอร์มของผู้รับ คนละฟอร์มกับตอนยื่น

```bash
curl -s -X POST "$BASE/request/requests/$REQUEST_NO/actions/complete" \
  -H "Authorization: Bearer $RFK_KEY" \
  -H "X-User-Token: $TOKEN_WORKER" \
  -H "Idempotency-Key: uat-bs01-$RUN-complete" \
  -H "Content-Type: application/json" \
  -d '{"receiver_form_data": {"summary": "เปิด SO-2026-0417 เรียบร้อย ส่งเข้าระบบจัดซื้อแล้ว"}}'
```

### 15-search-created

ทำในนาม: ผู้ขอ (`$TOKEN_REQUESTER`) · ผลที่ควรได้: **200 · ใบจาก 04 มี available_actions มี close**

> ผู้ขอหาใบที่ตัวเองยื่น

```bash
curl -s -X GET "$BASE/request/requests?view=created&status=approved" \
  -H "Authorization: Bearer $RFK_KEY" \
  -H "X-User-Token: $TOKEN_REQUESTER"
```

### 16-actions-requester

ทำในนาม: ผู้ขอ (`$TOKEN_REQUESTER`) · ผลที่ควรได้: **200 · มี close**

```bash
curl -s -X GET "$BASE/request/requests/$REQUEST_NO/actions" \
  -H "Authorization: Bearer $RFK_KEY" \
  -H "X-User-Token: $TOKEN_REQUESTER"
```

### 17-close

ทำในนาม: ผู้ขอ (`$TOKEN_REQUESTER`) · ผลที่ควรได้: **201 · status = closed**

> ผู้ขอเท่านั้น

```bash
curl -s -X POST "$BASE/request/requests/$REQUEST_NO/actions/close" \
  -H "Authorization: Bearer $RFK_KEY" \
  -H "X-User-Token: $TOKEN_REQUESTER" \
  -H "Idempotency-Key: uat-bs01-$RUN-close" \
  -H "Content-Type: application/json" \
  -d '{"note": "ได้เลข SO แล้ว ปิดเรื่อง"}'
```

### N1-receive-by-requester

ทำในนาม: ผู้ขอ (`$TOKEN_REQUESTER`) · ผลที่ควรได้: **403 FORBIDDEN**

> ทำก่อน 08: ผู้ขอรับเรื่องแทนผู้รับไม่ได้

```bash
curl -s -X POST "$BASE/request/requests/$REQUEST_NO/actions/receive" \
  -H "Authorization: Bearer $RFK_KEY" \
  -H "X-User-Token: $TOKEN_REQUESTER" \
  -H "Content-Type: application/json" \
  -d '{}'
```

### N2-close-by-worker

ทำในนาม: ผู้ทำ BSD (`$TOKEN_WORKER`) · ผลที่ควรได้: **403 FORBIDDEN**

> ทำหลัง 14: ผู้ทำปิดแทนผู้ขอไม่ได้

```bash
curl -s -X POST "$BASE/request/requests/$REQUEST_NO/actions/close" \
  -H "Authorization: Bearer $RFK_KEY" \
  -H "X-User-Token: $TOKEN_WORKER" \
  -H "Content-Type: application/json" \
  -d '{"note": "ทดสอบ"}'
```

## 3. ผลยิงจริง 2026-10-28 (`*.response.json`)

ยิงที่ UAT `http://192.168.31.52:3503/api/v1` ด้วย `X-Acting-User` (อีเมล) แทน `X-User-Token`
ไฟล์ `*.response.json` = `{status, body}` ซึ่งปิดเบอร์โทร เบอร์ภายใน รหัสพนักงาน และวันเริ่มงานเป็น `<redacted>` ไว้

**รอบแรก (`REQ-OSD-BS-01-26100003`)** BS-01 ยังมี flow `RECEIVE → WORK → CONFIRM` ผู้ทำจึงไม่มี `complete` และผู้ขอ `close` ไม่ได้ (409 `REQ_STEP_INVALID`) ต้องใช้ `advance` แทน
หลังจากนั้นลบ flow ของ BS-01 ออกจาก DB แล้ว (สำรองไว้ที่ `~/db-backups/bs01-flows-2026-10-28.json`)

**รอบสอง (`REQ-OSD-BS-01-26100004`, ไม่มี flow)** ไฟล์ 04, 07–09b, 14, 16, 17 มาจากรอบนี้ ส่วน 01–03, 05, 06, 10–13, 15, 18, N1, N2 มาจากรอบแรก (shape เหมือนกัน)

| ขั้น | คาด | ได้จริง |
|---|---|---|
| 01 `q=SO` | มี BS-01 | ไม่มี เพราะชื่อเปลี่ยนเป็น "ขอเปิด Request" ใช้ `q=BS-01` แทน |
| 02 | `ref_required = true` | `ref_required = false` · `receiver_candidates = []` |
| 04 | ต้องกรอก 6 ช่องบังคับ | ส่งแค่ `subject` + `objective` ก็ได้ 201 `submitted` |
| 09 | assignee = ผู้ทำ | `assigneeUserId` ถูกต้อง แต่ response ของ action ไม่มี `assignee` / `receiver` / `requester` เลย ต้องอ่านใบใหม่ด้วย 06 |
| 14 | `complete` → `approved` | ตรงตามคาด · `receiverFormData.summary` ถูกเก็บ |
| 16 / 17 | มี `close` → `closed` | ตรงตามคาด |
| N1 / N2 | 403 | 403 `FORBIDDEN` ตรงตามคาด |
