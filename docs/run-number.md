# เลขรันเอกสาร (run-number-service)

เลขที่คำขอและรหัสเอกสาร CRM ทุกชนิดออกจากที่เดียว: `run-number-service`
(port 3004) ซึ่งเป็นเจ้าของ `run_number_settings` และ `run_number_counters`
แต่ผู้เดียว service อื่นขอเลขผ่าน `POST internal/run-numbers/issue`

รูปแบบเลขแก้ได้จากหน้า **ตั้งค่าเลขรัน** โดยไม่ต้อง deploy (D-09)

## ชนิดเอกสารและค่าที่ backfill มา

| docType | รูปแบบตั้งต้น | ความยาวลำดับ | รีเซ็ต |
|---|---|---|---|
| `REQUEST` | `REQ-{COMPANY_PREFIX}-{TYPE}-{YYMM}{SEQ}` | 4 | รายเดือน |
| `CUSTOMER` | `CUS-{COMPANY_PREFIX}-{SEQ}` | 6 | ไม่รีเซ็ต |
| `OPPORTUNITY` | `OPP-{COMPANY_PREFIX}-{SEQ}` | 6 | ไม่รีเซ็ต |
| `SALE_ORDER` | `SO-{COMPANY_PREFIX}-{SEQ}` | 6 | ไม่รีเซ็ต |
| `QUOTATION` | `QT-{COMPANY_PREFIX}-{SEQ}` | 6 | ไม่รีเซ็ต |

`REQUEST` มีได้หลายแถวต่อบริษัท แยกด้วย `scopeKey` = `typeCode` ของประเภทคำขอ
แถว `scopeKey = '*'` คือค่าที่ประเภทซึ่งไม่มีแถวของตัวเองใช้ ชนิดอื่น `scopeKey`
เป็น `*` เสมอ

## ตัวแปรใน pattern

| token | ค่า |
|---|---|
| `{COMPANY_PREFIX}` | `Company.docPrefix` — `{PREFIX}` เป็นชื่อเดิม ยังใช้ได้ |
| `{COMPANY_CODE}` | `Company.code` |
| `{TYPE}` | `scopeKey` — แจกให้ `REQUEST` เท่านั้น |
| `{YYYY}` `{YY}` | ปี ค.ศ. |
| `{BYYYY}` `{BYY}` | ปี พ.ศ. |
| `{MM}` `{DD}` | เดือน / วัน สองหลัก |
| `{YYYYMM}` `{YYMM}` `{YYYYMMDD}` | รูปแบบรวม |
| `{SEQ}` | ลำดับ เติมศูนย์ตาม `seqPadding` |
| `{M:REQUEST_TYPE}` | รหัสประเภทคำขอ (เฉพาะ `REQUEST`) |

คำนำหน้าอย่าง `REQ` / `CUS` เป็นตัวอักษรตรง ๆ ใน pattern ไม่ใช่ token — admin
จึงแก้ได้เอง ซึ่งเป็นสิ่งที่ token ทำไม่ได้

### เพิ่ม token จาก master data

สองงานคู่กันเสมอ มิฉะนั้นจะได้ pattern ที่บันทึกผ่านแต่ออกเลขไม่ได้:

1. ประกาศใน `MASTER_TOKENS` (`libs/share/src/run-number/run-number-tokens.ts`)
2. แก้ผู้เรียกทุกตัวของ docType นั้นให้ส่งค่ามาใน `RunNumberContext.master`

`validatePattern` ปฏิเสธ token ที่ไม่ได้ประกาศตอนบันทึก และ `unresolvedTokens`
ปฏิเสธตอนออกเลขถ้าผู้เรียกไม่ส่งค่ามา — ด่านที่สองมีไว้กันกรณีที่ทำข้อ 1 แล้วลืมข้อ 2

## รอบรีเซ็ตกับ counter

`periodKey` ของ counter มาจากรอบรีเซ็ต: `-` (ไม่รีเซ็ต), `2026`, `202609`,
`20260922` เลขจึงกลับไปเริ่มที่ `startNumber` เองเมื่อขึ้นรอบใหม่ ไม่มีงานเบื้องหลัง
มาล้างค่า

`validatePattern` บังคับว่ารอบรีเซ็ตต้องมี token วันที่รองรับครบ — รีเซ็ตรายเดือน
โดย pattern ไม่มีทั้งปีและเดือนคือสั่งให้ออกเลขซ้ำตรง ๆ

### เขตเวลา

วัน/เดือน/ปีตัดตามเวลาไทย ผ่าน `RUN_NUMBER_TZ_OFFSET_MINUTES = 420`
ของเดิมตัดตาม UTC ทำให้คำขอที่ส่ง 02:00 ของวันที่ 1 ได้เลขของเดือนก่อน
ตั้งค่านั้นเป็น `0` เพื่อกลับไปใช้ UTC

## counter ไม่ผูก FK กับ setting

ตั้งใจ ถ้าผูกไว้ การลบ setting แล้วสร้างใหม่จะพาลำดับกลับไปเริ่มที่ 1 แล้วออกเลขซ้ำ
กับเอกสารที่ส่งออกไปแล้ว (NFR-03) ด้วยเหตุเดียวกัน แถวที่ใช้งานอยู่แถวสุดท้ายของ
ชนิดเอกสารจึงลบและปิดไม่ได้ (`RUN_NUMBER_SETTING_IN_USE`)

## ผลของการแยกเป็น service

`RunNumberService.issue` อยู่คนละ process กับผู้เรียก HTTP เข้า transaction ของ
Postgres ไม่ได้ เลขจึงออก **นอก** transaction ที่บันทึกเอกสาร สามอย่างที่ทำให้
ยอมรับได้:

1. **ออกเลขหลังตรวจทุกอย่างผ่านแล้ว** — `submit` ทำ `assertSubmittable`,
   `assertReceivable`, `assertRoutable` ก่อน การสร้างที่ถูกปฏิเสธจึงไม่กินเลข
2. **`Idempotency-Key`** — `submit` ส่ง `run-number:REQUEST:<requestId>:<typeCode>:<attempt>`
   การ retry จึงได้เลขเดิมกลับมา ไม่ใช่เลขใหม่ (เก็บไว้ 24 ชม.)
   การสร้างเอกสาร CRM ไม่ส่งคีย์ เพราะ `IdempotencyInterceptor` ของ core-service
   คุม retry ของคำขอทั้งใบไว้ชั้นนอกแล้ว
3. **ช่องว่างเลขยอมรับได้ เลขซ้ำไม่ได้** — transaction ที่ล้มโดยไม่มีใคร retry
   ทิ้งเลขที่กินไปแล้ว ซึ่งเป็นกฎเดิมของระบบนี้อยู่แล้ว

**ลำดับ deploy: run-number-service ต้องขึ้นก่อน core-service** ถ้ามันไม่ตอบ
การสร้างเอกสารทุกชนิดล้มพร้อมกัน

### การยืนยันตัวตนระหว่าง service

core-service **ส่งต่อ credential ของคำขอ** ไม่ได้ใช้ credential ของตัวเอง ซึ่งเป็น
แบบเดียวกับที่ `internal/policy/resolve` ของ user-service ใช้อยู่

`requestContextMiddleware` (`libs/share/src/context/request-context.ts`) เก็บ header
`authorization` ตามที่มาถึงไว้ใน AsyncLocalStorage ก่อน guard ตัวใดจะแก้ แล้ว
`RunNumberClient` หยิบไปใช้ — จุดเรียกทั้งหกจึงไม่ต้องรับ token ผ่าน signature
ลงทะเบียนไว้ใน `main.ts` ของ core-service และ external-service

เก็บ **ดิบ** โดยตั้งใจ: คำขอจากหน้าจอพา token ของคนมา ส่วน external-service พากุญแจ
`rfk_` มา ปลายทางตีความทั้งสองแบบได้ด้วย guard ชุดเดิม ถ้าแปลงเป็น service-account
token ของ core เองจะโดน `RemotePrincipalGuard` ปฏิเสธ เพราะ AUTH-06 กำหนดว่า
บัญชีบริการต้องมาพร้อมกุญแจ สิทธิ์อ่านจาก `api_keys.scopes` ที่เดียว

`X-Company-Id` ส่งเป็นบริษัทของเอกสารนั้น บริษัทจึงมาจากด่านไม่ใช่จาก body

route ประกาศ `@Authenticated()` + `@ServiceAccountAllowed()` ไม่ใช่ `@Permissions()`
— สิทธิ์สร้างเอกสาร (`request.create`, `crm.sales.manage`) ถูกตรวจที่ service
ต้นทางไปแล้ว

### การข้ามรหัสที่ถูกใช้ไปแล้ว

รหัสไม่ซ้ำทั้งฐานข้อมูลขณะที่ counter แยกต่อบริษัท เลขถัดไปจึงชนของบริษัทอื่นได้
(`Company.docPrefix` ไม่ unique) การวนหาเลขว่างอยู่ที่ **core-service** ผ่าน
`RunNumberClient.issueUnused` เพราะตารางที่ตอบว่ารหัสถูกใช้หรือยังอยู่ที่นั่น
run-number-service เองไม่รู้และไม่ควรรู้

## เพิ่มชนิดเอกสารใหม่

1. `RUN_NUMBER_DOC_TYPES` ใน `libs/share/src/run-number/run-number.types.ts`
2. `MASTER_TOKENS` ในไฟล์ `run-number-tokens.ts` (ใส่ `[]` ถ้ายังไม่มี token)
3. migration ที่ seed แถวตั้งต้นให้ทุกบริษัท (ดู `20260922100000_run_number_service`)

คอลัมน์ `docType` เป็น text ไม่ใช่ enum ของ Postgres เพื่อให้ข้อ 3 เป็น seed
ไม่ใช่การแก้ชนิดข้อมูล

## ตารางเก่า

`doc_number_configs`, `doc_number_counters` และ counter ของ CRM สี่ตัวยังอยู่ใน
ฐานข้อมูลแต่ **ไม่มีโค้ดอ่านแล้ว** เก็บไว้หนึ่ง release เพื่อให้ถอยกลับได้ แล้วลบ
ด้วย migration ตามหลัง
