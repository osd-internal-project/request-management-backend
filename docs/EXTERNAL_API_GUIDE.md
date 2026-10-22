# คู่มือ External API — เดินสายงานตั้งแต่ Lead จนถึงงานบริการ

คู่มือนี้สำหรับทีมที่ต่อระบบภายนอก (เว็บไซต์, chatbot, PMO tool, ระบบ monitoring,
helpdesk ของพาร์ตเนอร์) เข้ากับ Connect the Dot เรียงตาม**ลำดับที่ต้องเรียกจริง** ตั้งแต่
Lead เข้าระบบจนถึงงานบริการหลังส่งมอบ

| อ่านอะไรที่ไหน | ไฟล์ |
|---|---|
| ลำดับการเรียกตามสายงาน + ตัวอย่าง (ไฟล์นี้) | `docs/EXTERNAL_API_GUIDE.md` |
| endpoint **ทั้งหมด** พร้อมสิทธิ์ทั้งสองประตู (สร้างอัตโนมัติ) | [`EXTERNAL_API_INDEX.md`](./EXTERNAL_API_INDEX.md) |
| field, enum, ตัวอย่าง body ของทุก endpoint | `docs/openapi/external-<module>.json` |
| การออกกุญแจ, MCP, LibreChat, การแก้ปัญหา auth | [`EXTERNAL_API.md`](./EXTERNAL_API.md) |
| Swagger UI ลองยิงได้ | `http://<host>:3503/api/docs` |

---

## 1. ก่อนยิงครั้งแรก

### 1.1 ที่อยู่

| สภาพแวดล้อม | Base URL |
|---|---|
| เครื่องภายใน OSD (docker) | `http://192.168.31.52:3503/api/v1` |
| เครื่องนักพัฒนา | `http://localhost:3003/api/v1` |

ระบบภายนอกเรียกได้**เฉพาะ external-service** พอร์ตนี้เท่านั้น — core-service (`3002`) เป็น
API ของหน้าเว็บ

### 1.2 Header ทุก request

| Header | บังคับ | ค่า |
|---|---|---|
| `Authorization` | ✅ | `Bearer rfk_…` — กุญแจ API ของช่องทางนั้น |
| `X-Acting-User` | ✅ เกือบทุกเส้น | อีเมลของ**พนักงาน**ที่ระบบกำลังทำแทน ทุกอย่างบันทึกเป็นชื่อคนนี้ |
| `X-Company-Id` | ไม่ | id บริษัท เมื่อคนนั้นอยู่หลายบริษัท — ว่าง = บริษัทหลักของเขา |
| `Idempotency-Key` | ควรส่งทุก POST ที่สร้างของ | ค่าใหม่ต่อหนึ่งเจตนา ยิงซ้ำค่าเดิมได้ผลเดิม ไม่เกิดรายการที่สอง |
| `Content-Type` | สำหรับ body | `application/json` |

เส้นที่**ห้าม**ส่ง `X-Acting-User` (ไม่มีคนอยู่ปลายสาย) อยู่ในข้อ 6

### 1.3 สองประตู — ทำไมได้ 403 ทั้งที่กุญแจถูก

ทุกเส้นตรวจสองชั้น:

1. **กุญแจ** — `scopes` ของ API key ต้องมีสิทธิ์ `integration.*` ของเส้นนั้น
2. **คน** — พนักงานใน `X-Acting-User` ต้องมีสิทธิ์เดียวกับที่หน้าจอขอ (`crm.sales.read`,
   `legal.contract.read`, `pm.project.manage`, …) และเห็นเฉพาะแถวที่หน้าจอให้เขาเห็น

ข้อความ `ผู้ใช้ที่ระบุใน X-Acting-User ไม่มีสิทธิ์ทำรายการนี้` = กุญแจถูกแล้ว แต่**คน**ไม่มีสิทธิ์
(`details[].reason` บอกชื่อสิทธิ์ที่ขาด) — แก้ที่ role ของคน ไม่ใช่ออกกุญแจใหม่

อ่านข้อมูลข้ามบริษัทหรือแถวที่มองไม่เห็นได้ **404 ไม่ใช่ 403** โดยเจตนา (ไม่เปิดเผยว่ามีอยู่)

### 1.4 สิทธิ์ของกุญแจ — ติ๊กเท่าที่ช่องทางนั้นใช้

ออกที่หน้า **ผู้ดูแลระบบ → กุญแจ API** (หรือ `yarn apikey:issue … --scope <สิทธิ์>`)
`scopes` ว่าง = ทำอะไรไม่ได้เลย

| ขั้นในสายงาน | สิทธิ์กุญแจ | เปิดอะไร |
|---|---|---|
| รับ Lead จากเว็บฟอร์ม/อีเวนต์ | `integration.crm.lead.create` | `POST crm/leads/intake` (ไม่มีคน) |
| workflow engine | `integration.crm.lead.read`, `integration.crm.lead.stage` | อ่าน facts / บันทึกขั้นของ Lead |
| งานขาย | `integration.crm.sales.read`, `integration.crm.sales.manage` | Lead, ดีล, ใบเสนอราคา, ใบสั่งขาย |
| ทะเบียนลูกค้า | `integration.crm.customer.read`, `integration.crm.customer.manage` | ลูกค้า ผู้ติดต่อ สถานที่ |
| ตั้งค่า CRM | `integration.crm.admin.manage` | `crm/admin/*` |
| ส่งต่องานระหว่างทีม (ขอ Solution, ขอทำสัญญา, คำขอทั่วไป) | `integration.request.create` | `request/*` ทั้งชุด |
| ช่องทางลูกค้าแจ้งเรื่อง | `integration.request.intake` | `request/intake/*` (ไม่มีคน) |
| ติดตามดีลทั้งสาย | `integration.flow.read` | `flow/*` |
| Pre-Sales | `integration.presales.read` | `presales/*` |
| สัญญา | `integration.legal.read` | `legal/*` |
| โครงการ | `integration.pm.read`, `integration.pm.manage` | `pm/*` (manage = เปิดโครงการ) |
| การส่งมอบ | `integration.delivery.read` | `delivery/*` |
| งานบริการ | `integration.support.read`, `integration.support.manage` | `support/*` (manage = เปิดใบสั่งงาน) |
| เปิดเคสอนุมัติจากโมดูลอื่น | `integration.approval.create` | `approval/cases` (ไม่มีคน) |

---

## 2. ภาพรวมสายงาน

```
 เว็บฟอร์ม / อีเวนต์ / LINE
        │  POST crm/leads/intake                         (ไม่มีคน)
        ▼
 ① Lead ── PATCH …/owner · …/status · POST …/activities
        │  POST crm/leads/{id}/convert
        ▼
 ② ดีล (Opportunity) ── GET crm/opportunities/{id}  → บอกรหัสประเภทคำขอส่งต่อของบริษัท
        │
        ├─ ③ ขอ Solution ── POST request/requests  type=SOL ref=ดีล
        │        └─ ติดตาม: GET presales/opportunities/{id}/solutions
        │
        ├─ ④ ใบเสนอราคา ── POST crm/opportunities/{id}/quotations
        │        └─ submit → (อนุมัติราคา) → send → accept
        │
        ├─ ⑤ ใบสั่งขาย ── POST crm/opportunities/{id}/sale-orders   (ลูกค้าเกิด + ดีลชนะ)
        │
        ├─ ⑥ ขอทำสัญญา ── POST request/requests  type=CTR ref=ดีล
        │        └─ ติดตาม: GET legal/contracts?opportunity_id={id}
        │
        └─ ⑦ เปิดโครงการ ── POST pm/projects  (จากสัญญาที่ลงนามแล้ว)
                 ├─ ⑧ ส่งมอบ/วางบิล: GET delivery/projects/{projectId}[/billing|/handovers]
                 └─ ⑨ งานบริการ: POST support/work-orders

 ทุกขั้น: GET flow/opportunities/{id}  → ดีลอยู่ขั้นไหน และเรียกอะไรต่อ
```

**จุดส่งต่องานระหว่างทีมคือ "คำขอ" (Platform Request)** — ขอ Solution, ขอ Demo/POC และ
ขอทำสัญญาไม่มี endpoint เฉพาะ ใช้ `POST request/requests` ตัวเดียวกับคำขอทั่วไป ผูกกับดีลด้วย
`ref_type=opportunity` + `ref_id=<เลขดีล>` หน้าดีลบนเว็บจะแสดงคำขอนั้นในการ์ดของมันทันที
รหัสประเภทเป็นค่าตั้งของแต่ละบริษัท อ่านจากดีลเสมอ อย่าฝังค่าในโค้ด

---

## 3. ทีละขั้น

ตัวอย่างใช้ตัวแปรนี้

```bash
B=http://192.168.31.52:3503/api/v1
KEY=rfk_xxxxxxxx
ME=somchai@osd.co.th
```

### ① รับ Lead จากภายนอก — ไม่มีคน

```bash
curl -s -X POST "$B/crm/leads/intake" \
  -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -H "Idempotency-Key: web-form-20261006-0001" \
  -d '{"name":"บจก. ตัวอย่าง เทคโนโลยี","contact_name":"สมชาย ใจดี",
       "phone":"0812345678","email":"somchai@example.co.th",
       "product_group":"Security","note":"สนใจระบบ CCTV 3 สาขา"}'
```

Lead เข้ากองกลางโดยไม่มีเจ้าของ รอพนักงานขายกดรับ (หรือมอบด้วย `PATCH crm/leads/{id}/owner`)
`source_code` ประทับจากกุญแจเองถ้ากุญแจออกพร้อม `--source`

### ② จาก Lead เป็นดีล

```bash
H=(-H "Authorization: Bearer $KEY" -H "X-Acting-User: $ME" -H 'content-type: application/json')

curl -s "${H[@]}" -X PATCH "$B/crm/leads/$LEAD/status"  -d '{"status":"qualified"}'   # รหัสจาก GET crm/leads/statuses
curl -s "${H[@]}" -X POST  "$B/crm/leads/$LEAD/convert" -d '{"title":"CCTV 3 สาขา","amount":1500000}'
```

`convert` ตอบดีลที่สร้าง เก็บ `id` (ใช้ใน path) และ `opportunityCode` (ใช้เป็น `ref_id`)
เปิดดีลตรงโดยไม่ผ่าน Lead ได้ด้วย `POST crm/opportunities` (ต้องมี `title` และ `customer_id`
หรือ `prospect_name`) — **ลูกค้าในทะเบียนยังไม่ต้องมีจนกว่าจะเปิดใบสั่งขาย**

### ③ ขอ Solution จาก Pre-Sales

```bash
# 1) ประเภทคำขอส่งต่อของบริษัทนี้
curl -s "${H[@]}" "$B/crm/opportunities/$OPP" | jq '{solutionRequestTypeCode, demoRequestTypeCode, contractRequestTypeCode}'
# 2) ฟอร์มและผู้รับที่เลือกได้ของประเภทนั้น
curl -s "${H[@]}" "$B/request/request-types/SOL/form"
# 3) ยื่น
curl -s "${H[@]}" -X POST "$B/request/requests" -H "Idempotency-Key: sol-$OPP-1" -d '{
  "type_code":"SOL","receiver_user_id":"<uuid จากข้อ 2 หรือ GET request/users>",
  "ref_type":"opportunity","ref_id":"OPP-OSD-26100012",
  "form_data":{"subject":"ออกแบบระบบ CCTV 3 สาขา", "...":"ตามช่องบังคับของฟอร์ม"}}'
```

ติดตามผล (อ่านอย่างเดียว — การออกแบบทำบนหน้าจอ Pre-Sales):

| ต้องการ | เรียก |
|---|---|
| Solution ทั้งหมดของดีล + สถานะอนุมัติ | `GET presales/opportunities/{id}/solutions` |
| รายละเอียด / เวอร์ชันที่ระบุ | `GET presales/solutions/{id}` · `…/versions/{no}` |
| ข้อเสนอทางเทคนิค (ไม่มีต้นทุน ส่งลูกค้าได้) | `GET presales/solutions/{id}/versions/{no}/proposal` |
| ใบเสนอราคาที่ทีม Pricing สร้างจาก Solution | `GET presales/solutions/{id}/quotations` |

Demo/POC ใช้รูปเดียวกันด้วย `demoRequestTypeCode`

### ④ ใบเสนอราคา

```bash
curl -s "${H[@]}" -X POST "$B/crm/opportunities/$OPP/quotations" -d '{
  "title":"ระบบ CCTV 3 สาขา","valid_until":"2026-11-30",
  "lines":[{"description":"กล้อง IP 4MP","quantity":24,"unit_price":5200}]}'
curl -s "${H[@]}" -X POST "$B/crm/quotations/$QT/submit" -d '{}'   # ขออนุมัติราคา
curl -s "${H[@]}" -X POST "$B/crm/quotations/$QT/send"              # หลัง approved
curl -s "${H[@]}" -X POST "$B/crm/quotations/$QT/accept" -d '{}'    # ลูกค้าตอบรับ
```

- `submit` เปิดคำขออนุมัติราคาให้อัตโนมัติ ใบค้างที่ `pending_approval` จนคำขอได้ผล
  margin ต่ำกว่าเกณฑ์ต้องส่ง `reason`
- แก้ใบที่ยื่นแล้วไม่ได้ ใช้ `POST …/revise` ออกเวอร์ชันใหม่
- ต้นทุนและ margin ถูกปกปิดถ้าคนใน `X-Acting-User` ไม่มีสิทธิ์เห็น (ฟิลด์หายไปเลย ไม่ใช่ `null`)

### ⑤ ใบสั่งขาย — จุดที่ลูกค้าเกิดและดีลปิดชนะ

```bash
curl -s "${H[@]}" -X POST "$B/crm/opportunities/$OPP/sale-orders" \
  -H "Idempotency-Key: so-$OPP-1" -d '{"quotation_id":"'$QT'"}'
```

ลำดับหาลูกค้า: ลูกค้าที่ดีลผูกอยู่ → `customer_id` ที่ส่งมา → รายเดิมที่เลขภาษี+สาขาตรง →
สร้างใหม่จากข้อมูลผู้มุ่งหวัง (ส่ง `customer` เพื่อกำหนดเอง) ใบสั่งขายถูกส่งเข้า SAP ผ่านคิว

### ⑥ ขอทำสัญญา แล้วติดตาม

ยื่นแบบข้อ ③ ด้วย `type_code` = `contractRequestTypeCode` ของดีล ฝ่ายกฎหมายร่าง ตรวจ อนุมัติ และ
ลงนามบนหน้าจอ ระบบภายนอกติดตามได้ (คนต้องถือ `legal.contract.read`):

| ต้องการ | เรียก |
|---|---|
| สัญญาที่เกิดจากดีลนี้ | `GET legal/contracts?opportunity_id={id}` |
| รายละเอียด (วันลงนาม, โครงการที่เปิดแล้ว) | `GET legal/contracts/{id}` |
| ข้อกำหนด: ความรับผิด ค่าปรับ ประกัน ระดับบริการ | `GET legal/contracts/{id}/terms` |
| งวดวางบิล | `GET legal/contracts/{id}/installments` |
| ข้อผูกพัน | `GET legal/contracts/{id}/obligations` |

### ⑦ เปิดโครงการจากสัญญาที่ลงนามแล้ว

```bash
curl -s "${H[@]}" "$B/pm/projects/openable-contracts"            # สัญญาที่เปิดได้
curl -s "${H[@]}" "$B/pm/projects/preview/$CONTRACT"              # problems ต้องว่าง
curl -s "${H[@]}" -X POST "$B/pm/projects" -H "Idempotency-Key: prj-$CONTRACT" \
  -d '{"contract_id":"'$CONTRACT'","manager_user_id":"<uuid>"}'
```

คนต้องถือ `pm.project.manage` · เปิดไม่ได้เมื่อสัญญายังไม่ลงนามครบ หมดอายุ เป็น NDA/MSA หรือ
เปิดโครงการไปแล้ว → `409 CONFLICT` พร้อมเหตุผล · ดึงหมุดหมายและงวดจากสัญญาให้เอง
อ่านต่อ: `GET pm/projects/{id}` · `GET pm/projects/{id}/milestones` · `GET pm/projects?opportunity_id={id}`

### ⑧ การส่งมอบและวางบิล — อ่านอย่างเดียว

| ต้องการ | เรียก |
|---|---|
| แผนส่งมอบ: รอบส่ง หมุดหมาย BOQ | `GET delivery/projects/{projectId}` |
| งวดของสัญญา สถานะวางบิล/SAP สิ่งที่ยังขวาง | `GET delivery/projects/{projectId}/billing` |
| การส่งต่อให้ทีมบริการ | `GET delivery/projects/{projectId}/handovers` |

ยืนยันติดตั้ง ใบรับรองการตรวจรับ และส่งวางบิลทำบนหน้าจอ (ลงนามเอกสารและสร้างรายการใน SAP)

### ⑨ งานบริการหลังส่งมอบ

```bash
curl -s "${H[@]}" "$B/support/assets?customer_id=$CUS"            # อุปกรณ์ที่ติดตั้ง
curl -s "${H[@]}" -X POST "$B/support/work-orders" -H "Idempotency-Key: alarm-7781" -d '{
  "customer_id":"'$CUS'","asset_id":"<ถ้ามี>","work_kind":"corrective",
  "severity":"high","subject":"กล้องชั้น 2 ภาพไม่ขึ้น"}'
```

สร้างเคสตามประเภทใบสั่งงานบริการที่ตั้งในหน้าตั้งค่า CRM แล้วยื่นทันที (นาฬิกา SLA เริ่ม)
คำตอบบอกว่าอยู่ในสิทธิ์บริการหรือต้องเก็บเงิน ติดตามต่อด้วย `GET request/requests/{requestNo}`
และ `GET support/work-orders/by-request/{requestId}` · ยังไม่ได้ตั้งประเภท → `409`
คนต้องถือ `service.asset.manage` · **ลูกค้าแจ้งเอง** ใช้ `request/intake/*` หรือ Customer Portal

### ติดตามทั้งสายในครั้งเดียว

```bash
curl -s "${H[@]}" "$B/flow/opportunities/$OPP"
```

```jsonc
{
  "stage": "contract",              // ขั้นที่ไปถึงไกลที่สุด: opportunity · presales · quotation
                                    //   · sale_order · contract · project · lost
  "next_steps": [ { "action": "...", "method": "POST", "path": "/api/v1/pm/projects", "note": "..." } ],
  "opportunity": { "id": "...", "opportunityCode": "OPP-…", "stage": "won", "...": "..." },
  "handoffs": {
    "solution": { "type_code": "SOL", "requests": { "visible": true, "data": [ { "requestNo": "...", "status": "..." } ] } },
    "demo": null,                   // บริษัทไม่ได้ตั้งขั้นนี้
    "contract": { "type_code": "CTR", "requests": { "visible": true, "data": [] } }
  },
  "solutions":   { "visible": true, "data": [] },
  "quotations":  { "visible": true, "data": [] },
  "sale_orders": { "visible": true, "data": [] },
  "contracts":   { "visible": false, "reason": "missing_permission" },
  "projects":    { "visible": true, "data": [] }
}
```

แต่ละส่วนอ่านในนามคนใน `X-Acting-User` ส่วนที่เขามองไม่เห็นตอบ `visible: false` พร้อม
`reason` (`missing_permission` · `forbidden` · `not_found`) แทนการล้มทั้งคำตอบ
`next_steps` เป็นคำแนะนำ — endpoint ปลายทางยังตัดสินเองว่าทำได้หรือยัง

---

## 4. ทำงานกับคำขอ (ทุกประเภท)

คำขอส่งต่อทุกใบ (SOL, CTR, คำขออนุมัติราคา, ใบสั่งงานบริการ …) เดินด้วยชุดเดียวกัน:

| ต้องการ | เรียก |
|---|---|
| คำขอที่ผูกกับดีล | `GET request/requests?ref_type=opportunity&ref_id=<เลขดีล>&type_code=SOL` |
| อ่านใบเดียว (เลขที่หรือ uuid) | `GET request/requests/{ref}` |
| ตอนนี้คนนี้ทำอะไรได้ | `GET request/requests/{ref}/actions` |
| สั่งทำ | `POST request/requests/{ref}/actions/{action}` |
| คิวงาน / นับงานค้าง | `GET request/requests?view=…` · `GET request/requests/summary` |

**อย่าเดา action และอย่าจำฟอร์ม** — ทั้งสองเป็นค่าตั้งที่แก้ได้จากหน้า admin ถาม `…/actions`
และ `request-types/{code}/form` ใหม่ทุกครั้ง สถานะหลังยื่นอาจเป็น `submitted` หรือ
`pending_approval` แล้วแต่ประเภท อ่านจากคำตอบ

---

## 5. Error

รูปเดียวทุกเส้น: `{ "code", "message", "details" }` — แยกด้วย `code` ข้อความเป็นภาษาไทยและเปลี่ยนได้

| HTTP | `code` | ความหมายที่พบบ่อย |
|---|---|---|
| 400 | `VALIDATION_FAILED` | body/query ผิด หรือขาด `X-Acting-User` — `details[].field` บอกช่อง |
| 401 | `UNAUTHORIZED` | กุญแจผิด ถูกเพิกถอน หมดอายุ หรือไม่ได้ส่ง |
| 403 | `FORBIDDEN` | กุญแจไม่มี `integration.*` ของเส้นนี้ **หรือ** คนไม่มีสิทธิ์ (ดู 1.3) หรือคนยังไม่ถูกจัดเข้าผังองค์กร |
| 404 | `NOT_FOUND` | ไม่มี หรือมองไม่เห็น (ข้ามบริษัท/นอกขอบเขต) — หรืออีเมลใน `X-Acting-User` ยังไม่เคย login เว็บ |
| 409 | `CONFLICT` | สถานะไม่ให้ทำ (เปิดโครงการซ้ำ, สัญญายังไม่ลงนาม, ยังไม่ได้ตั้งประเภทคำขอ) |
| 422 | `REQ_FIELD_MISSING` ฯลฯ | ฟอร์มคำขอขาดช่องบังคับ — รวมถึง `ref_id` เมื่อประเภทนั้น `ref_required` |
| 502 | `STORAGE_UNAVAILABLE` | ขอไฟล์แนบผ่าน External API — ดาวน์โหลดจากหน้าเว็บ |

---

## 6. เส้นที่ไม่มีคนอยู่ปลายสาย — ห้ามส่ง `X-Acting-User`

| เส้น | ใช้เมื่อ |
|---|---|
| `POST crm/leads/intake` | เว็บฟอร์ม/อีเวนต์ส่ง Lead เข้ากองกลาง |
| `GET crm/leads/{id}/facts` · `POST crm/leads/{id}/stage` | workflow engine อ่านข้อเท็จจริงและบันทึกขั้นที่ตัดสินแล้ว |
| `POST request/intake` | ระบบยื่นคำขอในนามตัวเอง (`source: "system"`) |
| `request/intake/web-forms/*` · `channels/*` · `status/*` | ช่องทางที่ลูกค้าแจ้งเรื่องเอง (กุญแจ `integration.request.intake`) |
| `POST approval/cases` | โมดูลอื่นเปิดเคสอนุมัติ |

---

## 7. สิ่งที่ตั้งใจไม่เปิดผ่าน External API

ทำบนหน้าจอเท่านั้น เพราะต้องใช้ไฟล์ ลายมือชื่อ หรือการตัดสินของคนในทีม:
การออกแบบ Solution (ขอบเขต BOQ ต้นทุน), ร่าง/ตรวจ/อนุมัติ/ลงนามสัญญา, การวางแผนโครงการ
(WBS งบประมาณ ทีม), ยืนยันติดตั้ง ใบรับรองการตรวจรับ ส่งวางบิลเข้า SAP, การดาวน์โหลดไฟล์แนบทุกชนิด
ถ้าระบบของคุณต้องการขั้นใดในนี้ แจ้งทีมเพื่อพิจารณาเปิดเพิ่ม — แต่ละเส้นใหม่ต้องมีคู่บนหน้าจอและสิทธิ์
ที่ตรงกัน (`downstream-route-parity.spec.ts`)

## 8. รับแจ้งเหตุการณ์ (Webhook) — ไม่ต้อง poll

ระบบเรียกเว็บของคุณเองเมื่อเกิดเหตุการณ์ เช่น คำขอถูกอนุมัติ มีงานรออนุมัติ หรือ SLA ใกล้หรือเกินกำหนด
รายการ event และรูปแบบ body อยู่ใน [`openapi/external-webhook.json`](./openapi/external-webhook.json) (OpenAPI 3.1 `webhooks`)

1. ขอให้ผู้ดูแลของบริษัทเพิ่มปลายทางในหน้า **ผู้ดูแล → Webhook** (สิทธิ์ `admin.integration.manage`)
   โดยระบุ URL ซึ่งต้องเป็น https และเลือก event ที่ต้องการ แล้วรับ **secret** ที่แสดงเพียงครั้งเดียว
2. ปลายทางต้อง**ตรวจลายเซ็นก่อนเชื่อทุกครั้ง** และตอบ 2xx ภายใน 10 วินาที
3. body มีแค่ id ถ้าต้องการรายละเอียด ให้เรียก GET ด้วย API key ตามปกติ เช่น `request_id` ใช้กับ `GET /api/v1/request/requests/{ref}`
   ส่วน event `lead.*` ไม่มี email หรือเบอร์โทรใน body ให้อ่านจาก `GET /api/v1/crm/ai/leads/{lead_id}`
   ตัวอย่างครบทั้งการตั้ง key, webhook และ use case ของ Lead สำหรับ AI agent อยู่ใน [`ex/lead-webhook.md`](./ex/lead-webhook.md)

```js
// Node — ใช้ body ดิบ ก่อน JSON.parse
const crypto = require('node:crypto');
function verify(rawBody, headers, secret) {
  const ts = headers['x-webhook-timestamp'];
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false; // กันการยิงซ้ำของเก่า
  const expected = 'sha256=' +
    crypto.createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');
  const got = String(headers['x-webhook-signature'] ?? '');
  return got.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}
```

- **ส่งซ้ำได้ และลำดับอาจสลับกัน** ให้ตัดรายการซ้ำด้วย `X-Webhook-Id` ถ้าตอบไม่เป็น 2xx ระบบจะส่งใหม่หลัง
  1 นาที, 5 นาที, 30 นาที, 2 ชั่วโมง และ 6 ชั่วโมง จากนั้นจะเลิกส่ง ระบบไม่ตาม redirect
- **best-effort** event ที่เกิดตรงจังหวะที่ระบบล่มอาจหายได้ ถ้าบริการของคุณเคยล่ม ให้ตรวจสอบย้อนหลังด้วย GET ของ API เดิม
- ปุ่ม **ทดสอบ** ในหน้าตั้งค่าจะส่ง `webhook.ping` และดูผลการส่ง 50 ครั้งล่าสุดได้จากปุ่ม **ประวัติการส่ง**
