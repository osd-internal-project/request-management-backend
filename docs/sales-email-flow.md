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
| ใครเรียก Graph | CTD (token, secret, แนบ PDF, ประวัติบน Lead) — OSD Workflow เรียก CTD ผ่าน plugin |

## เส้นทาง

```
Vuvagent กรอก Product/Segment → Lead "qualified"
  └ trigger lead.status_changed [qualified] → workflow ctd-sales-s1
       POST crm/ai/leads/{leadId}/emails            ขอบคุณ + proposal (ข้อ 3)
ลูกค้าตอบ → core อ่าน inbox (เฉพาะเธรดที่ระบบเปิด) → จัดประเภท → กิจกรรม + แจ้งเจ้าของ
  └ event crm.email.received {intent}                                   (ข้อ 4)
       [interested]  → workflow ctd-sales-quote                          (ข้อ 5)
            POST crm/ai/leads/{leadId}/convert           → opportunityId
            POST crm/ai/opportunities/{oppId}/quotations → approved (ราคามาตรฐาน)
                 422 CRM_QUOTATION_UNPRICED → human task ให้เจ้าของ Lead
            POST crm/ai/quotations/{qtId}/email          → PDF ในเธรดเดิม + sent
       [confirmed | purchase_order] → workflow ctd-sales-close            (ข้อ 6)
            POST crm/ai/quotations/{quotationId}/accept  {email_id, po_no?}
       [needs_info | unclear] → human task ให้เจ้าของตอบเอง
       [not_interested]       → จบ (เจ้าของตัดสินว่าจะ disqualify)
```

แยกเป็นสาม workflow เพราะแต่ละคำตอบของลูกค้าคือ event ใหม่หนึ่งครั้ง (resource =
อีเมลขาเข้าแต่ละฉบับ) — ไม่ต้องใช้ "Wait for signal" และ instance ไม่ค้างรอเป็นสัปดาห์

## API (external-service, `@ActsAsCompany`, key ผูกบริษัท)

| route | scope | หมายเหตุ |
|---|---|---|
| `POST crm/ai/leads/:id/emails` | `crm.email.send` + `crm.lead.read.all` | body: `subject?`, `body` (ข้อความธรรมดา), `signature?`, `attachments?[{file_name, content_type, content_base64}]` ≤ 5 ไฟล์ / 3 MB · ผู้รับ = อีเมลบน Lead |
| `GET crm/ai/emails/:id` | `crm.email.read` + `crm.lead.read.all` | `intent`, `intent_label`, `intent_reason`, `body_text`, `attachments` |
| `POST crm/ai/opportunities/:id/quotations` | `crm.quotation.create` + `crm.sales.read.all` | `items?[{product_code, quantity, term_months?}]` — ว่าง = `intake_data.products` หรือ `subProduct` ของ Lead |
| `POST crm/ai/quotations/:id/email` | `crm.email.send` + `crm.sales.read.all` | เฉพาะ `approved`; ตอบข้อความล่าสุดของลูกค้า แนบ PDF แล้วเป็น `sent` |
| `POST crm/ai/quotations/:id/accept` | `crm.quotation.accept` + `crm.sales.read.all` | `email_id?`, `po_no?`, `note?` → `accepted` |

(ทุก scope ขึ้นต้นด้วย `integration.`) preset ในหน้า API key: **OSD Workflow — งานขายอัตโนมัติ**

`intake_data.products` ที่ Vuvagent ควรเขียน: `[{"product_code": "<SAP ItemCode>", "quantity": 1}]`

### ผลจัดประเภท (`EMAIL_INTENTS`)

`interested` · `needs_info` · `not_interested` · `confirmed` (ได้เฉพาะหลังส่งใบเสนอราคาในเธรดแล้ว)
· `purchase_order` (ไฟล์ชื่อ PO หรือข้อความกล่าวถึง PO) · `unclear`

`LLM_MODE=gateway` ใช้ LLM (task `crm.email.intent` ตั้ง model/quota ได้ที่หน้าตั้งค่า LLM);
mock หรือ LLM ตอบไม่เป็น JSON → กฎคำสำคัญใน `mail-rules.ts` (`intent_source` บอกว่ามาจากทางไหน)

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
