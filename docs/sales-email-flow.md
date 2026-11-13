# งานขายอัตโนมัติ: อีเมล → ใบเสนอราคา → ลูกค้ายืนยัน (5 พ.ย. 2569)

ข้อ 1–2 (สแกนนามบัตร/กวาด Lead, Product + Segment) Vuvagent ทำผ่าน API อยู่แล้ว
เอกสารนี้คือข้อ 3–6: CTD ถือข้อมูลและ mailbox, OSD Workflow ถือลำดับงาน
("Workflow owns Process, Core owns Data")

## ข้อตัดสินของผู้ใช้

| เรื่อง | ตัดสิน |
|---|---|
| อนุมัติราคา | ราคามาตรฐานล้วนไม่ต้องอนุมัติ (`autoApproveStandardPrice` ในตั้งค่า CRM, ค่าตั้งต้นเปิด) |
| ผู้ส่ง | shared mailbox ของบริษัท; ระหว่างรอ IT ใช้ mailbox M365 ของผู้พัฒนา (`MAIL_MAILBOX`) |
| ระบบอีเมล | Microsoft 365 → Microsoft Graph |
| สินค้า/ราคา | สินค้าบน Lead จับคู่กับราคามาตรฐาน (CD-194); ไม่มีราคา → งานกลับไปที่พนักงานขาย |
| requirement ก่อนเสนอราคา (13 พ.ย.) | "ครบ" = รู้ product + จำนวน + ตอบครบตามคำถามประจำ product (ตั้งบนหน้าชุดรายการ); ขาด → ระบบส่งอีเมลถามเอง |
| ไม่มี solution ในระบบ (13 พ.ย.) | ส่งงานให้พนักงานขาย — ขอราคาจาก Pricing หรือ Solution จาก Pre-Sales เอง แล้วกด "เริ่ม" ขั้นใบเสนอราคา |
| ใครเรียก Graph | CTD (token, secret, แนบ PDF, ประวัติบน Lead) — OSD Workflow เรียก CTD ผ่าน plugin |

## เส้นทาง

```
Vuvagent กรอก Product/Segment + วาง proposal  POST crm/ai/leads/{id}/files kind=proposal
เซลล์ย้าย Lead เป็น "Negotiation" (6 พ.ย.: เดิม qualified)
  └ trigger lead.status_changed [negotiation] → workflow ctd-sales-intro
       POST crm/ai/leads/{leadId}/emails {attach_proposal: true}  ขอบคุณ + proposal (ข้อ 3)
            ไม่มี proposal บน Lead → 409 → human task ให้เจ้าของ
ลูกค้าตอบ → core อ่าน inbox (เฉพาะเธรดที่ระบบเปิด) → จัดประเภท → กิจกรรม + แจ้งเจ้าของ
  └ event crm.email.received {intent}                                   (ข้อ 4)
       [interested]  → workflow ctd-sales-quote                          (ข้อ 5)
            POST crm/ai/emails/{emailId}/assessment      → outcome (13 พ.ย. — ดูหัวข้อถัดไป)
                 ask         → POST crm/ai/emails/{emailId}/requirement-request แล้วจบ
                               (คำตอบของลูกค้า = อีเมลใหม่ → รอบใหม่ของ workflow เดิม)
                 no_solution → human task: เซลล์ขอราคาจาก Pricing / Solution จาก Pre-Sales
                 handover    → human task: เซลล์ติดต่อลูกค้าเอง
                 ready       ↓
            POST crm/ai/leads/{leadId}/convert           → opportunityId
                 Lead ยังอยู่ขั้นเดิม (ไม่เป็น Won) — แปลงซ้ำ = 409
            POST crm/ai/opportunities/{oppId}/quotations → approved (ราคามาตรฐาน)
                 422 CRM_QUOTATION_UNPRICED → human task ให้เจ้าของ Lead
            POST crm/ai/quotations/{qtId}/email          → PDF ในเธรดเดิม + sent
                 ดีล qualifying → proposing, มูลค่าดีล = ยอดสุทธิใบเสนอราคา (ถ้ายังว่าง)
       [confirmed | purchase_order] → workflow ctd-sales-close            (ข้อ 6)
            POST crm/ai/quotations/{quotationId}/accept  {email_id, po_no?}
            Lead → Won ที่นี่ (ผู้ใช้ตัดสิน 11 พ.ย. 2569: Won = ลูกค้ายืนยัน/ส่ง PO หรือเปิดใบสั่งขาย)
            ดีลไม่ปิดชนะเอง — ชนะ = เซลล์เปิดใบสั่งขาย (PO 10 ก.ย.); แจ้งเตือนบอกให้เปิดใบสั่งขาย
       [negotiation] → ดีล → negotiating + แจ้งเจ้าของให้ทำคำขอส่วนลด (CD-80) หรือออกฉบับใหม่
       [needs_info | unclear] → human task ให้เจ้าของตอบเอง
       [not_interested]       → จบ (เจ้าของตัดสินว่าจะ disqualify)
```

แยกเป็นสาม workflow เพราะแต่ละคำตอบของลูกค้าคือ event ใหม่หนึ่งครั้ง (resource =
อีเมลขาเข้าแต่ละฉบับ) — ไม่ต้องใช้ "Wait for signal" และ instance ไม่ค้างรอเป็นสัปดาห์

## requirement ก่อนออกใบเสนอราคา (13 พ.ย. 2569, ผู้ใช้ตัดสิน)

เดิมลูกค้าตอบว่าสนใจ ระบบออกใบเสนอราคาทันที ตอนนี้ `assessment` อ่านคำตอบก่อน
(`mail/requirement-rules.ts`, pure + เทสต์):

| ต้องรู้ | มาจากไหน |
|---|---|
| product | ที่พนักงานขายเลือกบน Lead (`selected_bundle` / `selected_product` / Sub Product) — ไม่มีจึงใช้ชื่อชุดรายการที่ลูกค้าเอ่ยในอีเมล |
| จำนวน | ตัวเลข + หน่วยในอีเมล ("50 เครื่อง", "จำนวน 20") — ไม่ต้องถามถ้า Lead มีรายการของตัวเอง (`intake_data.products`) |
| คำถามประจำ product | `product_bundles.requirements` `[{key, question, hints[]}]` ตั้งบนหน้า "ชุดรายการของ Product" |

- คำตอบสะสมบน Lead ที่ `intake_data.requirements` (`product`, `quantity`, `answers{key}`, `outcome`,
  `missing[]`, `reason`, `email_id`) — อีเมลฉบับถัดไปเติมจากที่รู้แล้ว ไม่ถามซ้ำ
- `LLM_MODE=gateway`: LLM อ่าน (task `crm.email.requirements`); mock/ตอบไม่เป็น JSON → กฎ:
  ข้อที่มี `hints` ถือว่าตอบเมื่อพบคำใดคำหนึ่ง; ข้อที่ไม่มี `hints` ถูกถามหนึ่งครั้ง แล้วข้อความ
  ที่ลูกค้าตอบอีเมลถามถือเป็นคำตอบ (คนอ่านต่อได้ ลูกค้าไม่ถูกถามซ้ำ)
- ลำดับตัดสิน (`decide`): ไม่รู้ product → ถาม (แนบชื่อชุดรายการที่มี); product ไม่มีรายการ หรือ item
  ไม่มีราคามาตรฐาน → `no_solution` **ก่อน** ถาม requirement (ไม่ซักลูกค้าเรื่องของที่ยังตั้งราคาไม่ได้);
  ขาดข้อใด → `ask`; ถามไปแล้ว 2 ครั้ง (`MAX_REQUIREMENT_ASKS`) ยังขาด → `handover`; ครบ → `ready`
- `no_solution` / `handover`: แจ้งเตือนเจ้าของ Lead + แถวใน `sales_automation_issues`
  (code `CRM_QUOTATION_UNPRICED`, field `requirements`) ให้การ์ดงานขายอัตโนมัติบอกเหตุผล —
  แก้แล้วกด "เริ่ม" ขั้นใบเสนอราคา ระบบประเมินใหม่จากข้อมูลปัจจุบัน
- อีเมลถาม: purpose `requirement_request`, ตอบข้อความของลูกค้าในเธรดเดิม; คำตอบที่กฎอ่านไม่ออก
  ("50 เครื่อง ที่ระยอง") ในเธรดที่ฉบับล่าสุดของเราเป็นอีเมลถาม ถูกจัดเป็น `interested` (ไม่ใช่ `unclear`)
- จำนวนที่ลูกค้าขอคูณ item ของชุด (จำนวนในชุด = ของ 1 หน่วย) ยกเว้น item ที่ตั้ง "จำนวนคงที่"
  (`fixedQuantity`) — ดู [`product-bundles.md`](./product-bundles.md)
- ยังไม่ทำ: ระบบไม่เปิดคำขอ Solution/ราคาให้เอง (ผู้ใช้เลือกให้เซลล์ทำ)

## API (external-service, `@ActsAsCompany`, key ผูกบริษัท)

| route | scope | หมายเหตุ |
|---|---|---|
| `POST crm/ai/leads/:id/emails` | `crm.email.send` + `crm.lead.read.all` | body: `subject?`, `body` (ข้อความธรรมดา), `signature?`, `attachments?[{file_name, content_type, content_base64}]` ≤ 5 ไฟล์ / 20 MB, `attach_proposal?` (แนบ proposal ล่าสุดบน Lead; ไม่มี = 409 field `proposal`) · ผู้รับ = อีเมลบน Lead |
| `POST crm/ai/leads/:id/files` | `crm.lead.update` | multipart `file` + `kind` (`proposal` \| `other`) ≤ 20 MB — Vuvagent วาง proposal ให้ Lead |
| `GET crm/ai/leads/:id/files` | `crm.lead.read.all` | รายการไฟล์บน Lead (ล่าสุดก่อน) |
| `GET crm/ai/emails/:id` | `crm.email.read` + `crm.lead.read.all` | `intent`, `intent_label`, `intent_reason`, `body_text`, `attachments` |
| `POST crm/ai/emails/:id/assessment` | `crm.email.read` + `crm.lead.read.all` | อีเมลขาเข้าของ Lead → `outcome` (`ready` \| `ask` \| `no_solution` \| `handover`), `reason`, `product`, `quantity`, `answers`, `missing[{key, question}]`, `asks_sent` · เก็บผลบน Lead |
| `POST crm/ai/emails/:id/requirement-request` | `crm.email.send` + `crm.lead.read.all` | body `intro?`, `signature?` · ถามเฉพาะ `missing` ของการประเมินล่าสุด (ไม่ใช่ `ask` = 409) · ผู้รับ = ผู้ส่งอีเมลฉบับนั้น |
| `POST crm/ai/opportunities/:id/quotations` | `crm.quotation.create` + `crm.sales.read.all` | `items?[{product_code, quantity, term_months?}]` — ว่าง = รายการของ Lead ตามลำดับใน [`product-bundles.md`](./product-bundles.md) |
| `POST crm/ai/quotations/:id/email` | `crm.email.send` + `crm.sales.read.all` | เฉพาะ `approved`; ตอบข้อความล่าสุดของลูกค้า แนบ PDF แล้วเป็น `sent` |
| `POST crm/ai/quotations/:id/accept` | `crm.quotation.accept` + `crm.sales.read.all` | `email_id?`, `po_no?`, `note?` → `accepted` |

(ทุก scope ขึ้นต้นด้วย `integration.`) preset ในหน้า API key: **OSD Workflow — งานขายอัตโนมัติ**

`intake_data.products` ที่ Vuvagent ควรเขียน: `[{"product_code": "<SAP ItemCode>", "quantity": 1}]`
(ใส่ `term_months` ได้สำหรับราคารายเดือน) — ไม่เขียนก็ได้ถ้า product ของ Lead มีชุดรายการ (12 พ.ย. 2569)

### ผลจัดประเภท (`EMAIL_INTENTS`)

`interested` · `needs_info` · `not_interested` · `confirmed` (ได้เฉพาะหลังส่งใบเสนอราคาในเธรดแล้ว)
· `negotiation` (ขอส่วนลด/ต่อรองราคาหรือเงื่อนไข — "ยืนยันถ้าลดให้" ก็นับเป็นต่อรอง) · `purchase_order` (ไฟล์ชื่อ PO หรือข้อความกล่าวถึง PO) · `unclear`

`LLM_MODE=gateway` ใช้ LLM (task `crm.email.intent` ตั้ง model/quota ได้ที่หน้าตั้งค่า LLM);
mock หรือ LLM ตอบไม่เป็น JSON → กฎคำสำคัญใน `mail-rules.ts` (`intent_source` บอกว่ามาจากทางไหน)

แจ้งเตือนเจ้าของ (`crm.email.received`) มี `{{next_step}}` บอกสิ่งที่ต้องทำต่อตามผลจัดประเภท

## ตั้งค่า

**หน้าจอ (แนะนำ):** ตั้งค่า → อีเมลงานขาย (`/pages/admin/mail-settings`, สิทธิ์
`admin.integration.manage`) — ต่อบริษัท: โหมด (ปิด / จำลอง / ส่งจริง), mailbox, tenant id,
client id, client secret (เข้ารหัสด้วย `CONFIG_SECRET_KEY` ไม่แสดงกลับ เว้นว่าง = ใช้ค่าเดิม)
และปุ่ม "ส่งอีเมลทดสอบ" ที่ใช้ค่าที่กรอกได้ก่อนบันทึก. บันทึกแล้วมีผลทันที ไม่ต้อง restart.
API: `GET/PUT admin/mail-settings`, `POST admin/mail-settings/test` (core).

**env (ค่าสำรอง):** บริษัทที่ยังไม่เคยบันทึกบนหน้าจอใช้ค่านี้ —
```
MAIL_MODE=off|mock|graph        # ตั้งให้ตรงกันทั้ง core และ external
MAIL_MAILBOX=sales@osd.co.th
MAIL_GRAPH_TENANT_ID / MAIL_GRAPH_CLIENT_ID / MAIL_GRAPH_CLIENT_SECRET
MAIL_POLL_INTERVAL_MS=60000     # core เท่านั้น (อ่าน inbox ของทุก mailbox ที่ส่งจริง)
```
external-service ต้องมี `CONFIG_SECRET_KEY` ตัวเดียวกับ core (เพื่อถอดรหัส secret ตอนส่ง)

ฝั่ง IT (Entra ID):
1. App registrations → New → ได้ tenant id + client id; Certificates & secrets → client secret
2. API permissions → Microsoft Graph → **Application**: `Mail.Send`, `Mail.ReadWrite` → Grant admin consent
3. จำกัดให้แตะได้เฉพาะ mailbox เดียว (Exchange Online PowerShell):
   `New-ApplicationAccessPolicy -AppId <client id> -PolicyScopeGroupId <mailbox หรือ mail-enabled group> -AccessRight RestrictAccess`
   ตอนนี้ใช้ mailbox ของผู้พัฒนา แล้วค่อยเปลี่ยนเป็น shared mailbox (แก้แค่ `MAIL_MAILBOX` + policy)

ต้องเป็น mailbox บน M365 ของบริษัท — Gmail ส่วนตัวใช้ทางนี้ไม่ได้

## ทดสอบก่อนมี mailbox จริง (`MAIL_MODE=mock`)

1. ส่งอีเมลขอบคุณผ่าน `POST crm/ai/leads/:id/emails` (ไม่มีอะไรออกนอกเครื่อง)
2. จำลองลูกค้าตอบ: `POST /api/v1/sales-emails/{email_id}/simulate-reply` บน core-service
   (สิทธิ์ `admin.integration.manage`) body `{"text": "สนใจครับ ขอใบเสนอราคา"}` หรือ
   `{"text": "แนบ PO", "attachment_names": ["PO-2026-001.pdf"]}`
3. ผลเดินทางเดียวกับอีเมลจริง: แถวใน `crm_emails`, กิจกรรม, แจ้งเตือนเจ้าของ, event → trigger

## ข้อมูล

`mail_settings` (migration `20261105110000_mail_settings`) — หนึ่งแถวต่อบริษัท.
`crm_emails` (migration `20261105100000_crm_emails`): ทุกฉบับที่ส่ง (รวมที่ล้มเหลว + เหตุผล)
และคำตอบของลูกค้าในเธรด — ไม่เก็บเนื้อไฟล์แนบ (ชื่อ/ชนิด/ขนาดเท่านั้น) ไม่มีเส้นลบ
หน้าจอ: `GET leads/:id/emails`, `GET opportunities/:id/emails` (core)

## หน้าจอบอกว่า workflow ติดเพราะอะไร (11 พ.ย. 2569)

การ์ด **งานขายอัตโนมัติ** บนหน้า Lead และหน้าโอกาสการขาย (`GET leads/:id/sales-automation`,
`GET opportunities/:id/sales-automation`; ซ่อนเมื่อบริษัทไม่มี trigger งานขายเลย) แสดงสองอย่าง:

1. **checklist สด** ต่อขั้น — ค่าพื้นฐาน (อีเมลงานขายของบริษัท, อีเมลผู้ติดต่อ), intro (trigger
   `lead.status_changed`·negotiation, ไฟล์ proposal), quote (trigger `crm.email.received`·interested,
   ผู้รับผิดชอบ, สินค้าที่มีราคามาตรฐานมีผลวันนี้), close (trigger confirmed/purchase_order,
   ใบเสนอราคาที่ส่งแล้ว) และผลการเริ่ม workflow ล่าสุดจาก `workflow_starts` (`dead` = เริ่มไม่สำเร็จ)
2. **ครั้งที่ติดจริง** — ทุกครั้งที่ route `crm/ai/*` ของ workflow ตอบ `AppError` (ยกเว้น 404/403)
   external-service เก็บลง `sales_automation_issues` พร้อม action/code/details; action เดิมสำเร็จ
   ภายหลัง = ใส่ `resolvedAt`. หน้าจอแสดงครั้งล่าสุดต่อ action ที่ยังไม่แก้ + วิธีแก้ (`hintFor`, ตาม code)

หมายเหตุ: workflow ของ trigger หนึ่งเริ่มเองได้ครั้งเดียวต่อ Lead/อีเมล — ย้ายสถานะซ้ำไม่เริ่มใหม่

### ปุ่ม "เริ่ม" ต่อขั้น (13 พ.ย. 2569)

รอบที่ติดจบที่งานของคนแล้วปิด ไม่มีอะไรปลุกมันอีก หลังแก้ข้อมูลครบ คนจึงสั่งเริ่มขั้นนั้นใหม่เองจากการ์ด:
`POST leads/:id/sales-automation/:step/start` (`crm.lead.manage`) และ
`POST opportunities/:id/sales-automation/:step/start` (`crm.sales.manage`), `step` = `intro | quote | close`

- กดได้เมื่อ checklist ตอบ `can_start` — ค่าพื้นฐานผ่าน, ทุกรายการของขั้นผ่าน (ไม่นับผลการเริ่มที่ `dead`),
  และไม่มีรายการที่ `pending`/`sending` อยู่; ไม่ผ่าน = 422
- มีแถว `workflow_starts` ของขั้นนั้นอยู่แล้ว → แถวเดิมกลับเป็น `pending` (ตัวแปรชุดเดิม) รอบถัดไปของ
  dispatcher เปิด instance ใหม่; ไม่เคยเริ่ม → สร้างแถวใหม่: intro ใช้ Lead (สถานะปัจจุบัน ไม่กรองตาม
  สถานะของ trigger เพราะคนสั่งเอง), quote/close ใช้อีเมลตอบล่าสุดที่ intent ตรง — ไม่มีอีเมลแบบนั้น = เริ่มไม่ได้
- workflow ทำขั้นนั้นใหม่ตั้งแต่ต้น: รอบก่อนส่งอีเมลไปแล้วลูกค้าจะได้ซ้ำ (หน้าจอถามยืนยันก่อน)
- audit `crm.sales_automation.step_started`
