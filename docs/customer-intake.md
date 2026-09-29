# คำขอจากลูกค้า — ช่องทางรับคำขอ (CD-66)

ลูกค้ายื่นคำขอเองได้ผ่าน **ช่องทางรับคำขอ** ของแต่ละบริษัท (ผู้ใช้ตัดสิน 29 ก.ย. 2569):
แบบฟอร์มสาธารณะก่อน — LINE และ AI CARE เป็น connector บนทางเดียวกัน

## หลักการ

- **ผู้ยื่นคือผู้ใช้ที่ช่องทางกำหนด** (เช่น service desk) — คำขอทุกใบต้องมีผู้ยื่นที่เป็นผู้ใช้ในระบบ
  ลูกค้าจึงถูกเก็บเป็น **ผู้ติดต่อ** บนคำขอ (`contactName/Email/Phone/Company/TaxId`, `channel`)
- **จับคู่ลูกค้า**: เลขภาษีตรงกับลูกค้าในบริษัท (สำนักงานใหญ่ก่อน) หรืออีเมลตรงกับผู้ติดต่อของลูกค้า →
  คำขออ้าง `ref_type=customer` จึงขึ้นในหน้าลูกค้า 360° / ไทม์ไลน์ / สุขภาพลูกค้า (Keeper) อัตโนมัติ
- ช่องทางเปิดให้ **เฉพาะประเภทคำขอที่ผู้ดูแลเลือก** — ประเภทที่ต้องแนบเอกสารหรือต้องอ้างอิงถูกทำเครื่องหมาย
  `needs_staff` (ลูกค้ากรอกเองให้ครบไม่ได้)
- ยื่นแล้ว **ส่งทันที** (ออกเลข เริ่ม SLA เข้าคิวผู้รับ) ลูกค้าได้ **เลขคำขอ + ลิงก์ติดตามสถานะ**
  `…/f/status/<token>` — token แสดงครั้งเดียว ระบบเก็บเฉพาะ sha256 ของมัน
  หน้าติดตามแสดงแค่เลข ประเภท สถานะ และกำหนดเสร็จ ไม่มีบันทึกภายในหรือชื่อพนักงาน

## ตั้งค่า (ผู้ดูแล)

หน้า **ผู้ดูแลระบบ › ช่องทางรับคำขอจากลูกค้า** (`admin.request-type.manage`) ต่อบริษัท ต่อช่องทาง:
เปิด/ปิด, ผู้ยื่นแทน, ประเภทคำขอที่เปิดรับ, (web form) หัวฟอร์ม ข้อความนำ และลิงก์ — กด "ออกลิงก์ใหม่"
เมื่อลิงก์หลุด ลิงก์เดิมใช้ไม่ได้ทันที

## API (external-service, key ที่ถือ `integration.request.intake` เท่านั้น)

| route | ใช้โดย |
|---|---|
| `GET  /api/v1/request/intake/web-forms/:slug` | หน้าแบบฟอร์ม (ฝั่ง server ของ frontend) |
| `POST /api/v1/request/intake/web-forms/:slug` | ส่งแบบฟอร์ม |
| `POST /api/v1/request/intake/channels/:channel` | AI CARE (`ai_care`) และ connector อื่น — บริษัท = บริษัทของ key |
| `GET  /api/v1/request/intake/status/:token` | หน้าติดตามสถานะ |
| `POST /api/v1/request/intake/line/:companyCode` | LINE webhook (`@Public`, ตรวจลายเซ็น LINE) |

**อย่าใช้ key ที่ถือ `integration.request.create`** กับช่องทางลูกค้า — scope นั้นเปิด route ที่ทำแทน
ผู้ใช้คนใดก็ได้ผ่าน `X-Acting-User` ด้วย

ออก key: หน้า API key หรือ `yarn apikey:issue` — scope `integration.request.intake`
- web form: key **ไม่ผูกบริษัท** (บริษัทมาจาก slug) หรือผูกบริษัทเดียวถ้ามีบริษัทเดียว — ใส่ที่ frontend env
  `CUSTOMER_INTAKE_API_KEY` + `EXTERNAL_API_URL` (ฝั่ง server เท่านั้น หน้าเว็บไม่เห็น key)
- AI CARE: key **ผูกบริษัท** ต่อบริษัท แล้วเรียก `POST …/channels/ai_care`

## แบบฟอร์มสาธารณะ (frontend)

- `/f/<slug>` และ `/f/status/<token>` เปิดได้โดยไม่ login (ยกเว้นใน `src/proxy.ts`)
- ส่งผ่าน route ของ frontend `POST /api/public/forms/<slug>` ซึ่ง: จำกัดอัตราต่อ IP (ค่าเริ่มต้น 5 ครั้ง/10 นาที
  ต่อ instance), ช่อง honeypot ที่คนมองไม่เห็น, แล้วค่อยเรียก external-service ด้วย key ของ server
- ไม่มี captcha — ถ้าเจอสแปมจริง เพิ่ม Turnstile/reCAPTCHA ที่ route นี้จุดเดียว

## LINE connector

ข้อความตัวอักษรที่ลูกค้าส่งเข้า LINE OA ของบริษัท → คำขอผ่านช่องทาง `line` (ประเภทแรกที่มีช่องข้อความ
ข้อความลงช่อง multiline แรก) → ตอบกลับเลขคำขอ + ลิงก์ติดตาม

ตั้งค่า (external-service env ต่อบริษัท ใช้รหัสบริษัทตัวพิมพ์ใหญ่):

```
LINE_CHANNEL_SECRET_OSD=...          # ใช้ตรวจลายเซ็น — ไม่มี = webhook ตอบ 404
LINE_CHANNEL_ACCESS_TOKEN_OSD=...    # ใช้ตอบกลับ/อ่านชื่อผู้ใช้ — ไม่มี = รับคำขอแต่ไม่ตอบ
PUBLIC_WEB_URL=https://ctd.example   # ต้นทางของลิงก์ติดตามในข้อความตอบกลับ
```

Webhook URL ใน LINE Developers: `https://<external-service>/api/v1/request/intake/line/OSD`
และเปิดช่องทาง LINE ในหน้าตั้งค่า (ผู้ยื่นแทน + ประเภทคำขอ)

ยังไม่ทำ: รูป/สติกเกอร์/ไฟล์, การคุยต่อเนื่องบนคำขอเดิม, การเลือกประเภทจากเมนู — ข้อความทุกข้อความ
เป็นคำขอใหม่ของประเภทแรก

## AI CARE connector

AI CARE (CD-23) เรียก `POST /api/v1/request/intake/channels/ai_care` ด้วย key ผูกบริษัท ส่ง
`type_code`, `form_data` และ `contact` แบบเดียวกับแบบฟอร์ม · เปิดช่องทาง AI CARE ในหน้าตั้งค่าก่อน

## แก้ไขระหว่างทำ (29 ก.ย. 2569)

- `POST request/intake` (REQ-10) **ยื่นไม่ผ่านทุกครั้ง** — `submit` ตรวจว่าผู้เรียกคือผู้ยื่น ซึ่งบัญชีบริการ
  ไม่มีวันเป็น ตอนนี้ทางของเครื่อง (intake และช่องทางลูกค้า) ยื่นแทนผู้ยื่นด้วย `forRequester` —
  ข้ามเฉพาะการตรวจเจ้าของ กติกาอื่นของการยื่นยังตรวจครบ
- `POST request/intake` ยอมให้ `company_id` ใน body ข้ามบริษัทของ key ที่ผูกไว้ — ตอนนี้ปฏิเสธ
  `COMPANY_FORBIDDEN`
