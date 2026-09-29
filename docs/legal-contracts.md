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
