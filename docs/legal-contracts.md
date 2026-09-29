# CD-13 Legal — คลังสัญญา (CD-161)

ผู้ใช้ตัดสินใจ 29 ก.ย. 2569: คู่สัญญาเป็นลูกค้าในทะเบียน **หรือ** คู่สัญญาอื่น (ชื่อ+เลขภาษี) ·
สิทธิ์ใหม่กลุ่ม `legal.*` + สัญญาลับพิเศษรายฉบับ · ค้นข้อความในไฟล์ PDF ที่แนบ

## ข้อมูล

- ต่อยอดตาราง `customer_contracts` (CD-70) — `customerId` เป็น NULL ได้เมื่อมี `counterpartyName`
  (DB CHECK `customer_contracts_party_check`)
- `kind`: `standard` (ซื้อขาย/บริการ) · `nda` · `msa` · `other`
- `confidential` + `contract_access` (ผู้ที่เปิดได้เพิ่ม)
- `contract_documents`: ไฟล์ใน object storage (`contracts/<id>/<doc>/<name>`) + `textContent`
  ที่ดึงจาก PDF ตอนแนบ (`pdf-parse`; `textStatus` = extracted / empty (สแกน ไม่มี OCR) /
  failed / not_pdf)

## สิทธิ์

| สิทธิ์ | |
|---|---|
| `legal.contract.read` | ค้นดูคลังสัญญาทั้งบริษัท |
| `legal.contract.manage` | บันทึก/แก้ไข แนบ/ลบไฟล์ ตั้งลับพิเศษและรายชื่อผู้เข้าถึง — เห็นสัญญาลับทุกฉบับ |

สัญญาลับพิเศษ: เห็นได้เฉพาะ `legal.contract.manage` ผู้รับผิดชอบ ผู้บันทึก และรายชื่อใน `contract_access`
— ใช้กฎเดียวกันในแท็บสัญญาของหน้าลูกค้า (`contractVisibleWhere`) · คนอื่นเปิดด้วย id ได้ 404

seed เพิ่ม role **`legal` (ฝ่ายกฎหมาย)** · admin ได้ `legal.contract.read` อัตโนมัติ (สิทธิ์อ่าน) แต่ไม่ได้ manage

## API (core-service, หน้าจอเท่านั้น)

`GET /contracts?search=&text=&kind=&status=&ends_from=&ends_to=&min_value=&max_value=&confidential=` ·
`GET/PATCH /contracts/:id` · `POST /contracts` · `PUT /contracts/:id/access` ·
`POST /contracts/:id/documents` (multipart ≤ 25 MB: PDF/Word/JPEG/PNG) ·
`GET/DELETE /contracts/:id/documents/:documentId`

## ผลต่อของเดิม

- ต่ออายุสัญญา (CD-70) เปิดดีลต่ออายุเฉพาะสัญญาที่มีลูกค้าและชนิด standard/msa (NDA/สัญญาผู้ขายไม่เปิดดีล)
- webpack ปล่อย `pdf-parse` ไว้นอก bundle (โหลดจาก node_modules ตอนรัน เหมือน Prisma)

## ก่อนใช้งาน

รัน migration `20260929420000_contract_repository` + `prisma:seed` (สิทธิ์ `legal.*` และ role `legal`)
แล้วมอบ role ฝ่ายกฎหมายให้ผู้ใช้

# CD-153..156 ข้อกำหนดของสัญญา

การ์ด "ข้อกำหนดของสัญญา" บนหน้าสัญญา (ตาราง `contract_terms` หนึ่งแถวต่อสัญญา) — ค่าที่วัดได้ ไม่ใช่ข้อความอิสระ:

| | บันทึก | ระบบคำนวณ/บังคับ |
|---|---|---|
| **ความรับผิด** (CD-153) | เพดานเป็นเงิน หรือ "ไม่จำกัด" | เกินมูลค่าสัญญา (หรือไม่จำกัด) → สร้าง+ยื่นคำขอประเภทที่ตั้งในหน้าตั้งค่า CRM (`liabilityApprovalRequestTypeCode`) ถึงผู้บริหาร · การ์ดแสดงผล (ร่าง / รออนุมัติ / อนุมัติ / ไม่อนุมัติ) · เปลี่ยนเพดาน = ขออนุมัติใหม่ · ยังไม่ตั้งประเภท/ยื่นไม่ผ่าน = บอกเหตุผล + ปุ่มขออนุมัติ |
| **ค่าปรับ** (CD-154) | ร้อยละ ต่อ วัน/สัปดาห์/เดือน/ครั้ง ของ ฐาน (มูลค่าสัญญา/งานที่ยังไม่ส่ง/ค่าบริการรายเดือน/อื่น) · เพดานเป็นร้อยละหรือเงิน | ค่าปรับสูงสุดเป็นเงิน · ผูก Milestone รอโมดูล PM |
| **การรับประกัน** (CD-155) | เดือน ขอบเขต ข้อยกเว้น **วันตรวจรับจริง** | ช่วงประกันนับจากวันตรวจรับ (ไม่ใช่วันลงนาม) — ยังไม่ตรวจรับ = "เริ่มนับเมื่อตรวจรับ" · วันตรวจรับกรอกเองจนกว่าจะมีโมดูล Delivery |
| **การยกเลิก** (CD-156) | บอกกล่าวล่วงหน้า (วัน) เงื่อนไข ผลที่ตามมา ขั้นตอนเมื่อเกิดจริง | — |

API: `GET/PUT /contracts/:id/terms` · `POST /contracts/:id/terms/liability-approval` · migration `20260929440000_contract_terms`
