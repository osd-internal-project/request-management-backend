# CD-78 จองเลขหมายบริการ (Reserve-phone)

ดีลที่ขายบริการเลขหมาย เช็กเบอร์ว่างจาก **Reserve-phone** แล้วจองผูกกับโอกาสการขาย
โดยมีวันหมดอายุ — คลังเลขหมายอยู่ที่ Reserve-phone ระบบนี้**ไม่เก็บทะเบียนเบอร์**
เก็บเฉพาะว่าการจองไหนเป็นของดีลไหน (`opportunity_phone_reservations`)

## ใช้งาน (หน้าโอกาสการขาย → การ์ด "เลขหมายที่จอง")

- ค้นเบอร์ว่าง (มีตัวเลข / ขึ้นต้นด้วย / ประเภท เช่นเบอร์สวย) → เลือกหลายเบอร์ → จอง N วัน
  (ตั้งต้น `RESERVE_PHONE_HOLD_DAYS` = 14, สูงสุด `RESERVE_PHONE_MAX_HOLD_DAYS` = 60)
- จองทีละเบอร์แยกกัน: เบอร์ที่ถูกจองไปก่อน (ในดีลอื่นหรือใน Reserve-phone) แจ้งเป็นรายเบอร์ ที่เหลือยังจองได้
- ต่ออายุ = นับใหม่จากวันนี้ · ปล่อยคืน = ทำได้แม้ดีลปิดแล้ว (ดีลที่ชนะอาจไม่ใช้บางเบอร์)
- ดีลที่ปิดแล้ว (ชนะ/แพ้) จองหรือต่ออายุไม่ได้
- สิทธิ์: ดู `crm.sales.read` · ค้น/จอง/ต่อ/ปล่อย `crm.sales.manage` + ต้องเห็นดีล (scope ขาย)

## อัตโนมัติ (core-service, ทุก `CRM_PHONE_RESERVATION_INTERVAL_MS`)

- ดีลถูกทำเป็น **แพ้** → ปล่อยเบอร์ทั้งหมดคืน (`releaseReason = deal_lost`); Reserve-phone ไม่ตอบ = ลองรอบถัดไป
- เลยวันหมดอายุ → สถานะ `expired` + แจ้งเจ้าของดีล
- ก่อนหมด `warn_days` วัน (กติกาแจ้งเตือน `phone.reservation`, ค่าตั้งต้น 3 วัน, ปิดได้ต่อบริษัท)
  → เตือนเจ้าของดีลครั้งเดียวต่อวันหมดอายุ (ต่ออายุแล้วเตือนใหม่ได้)
- ข้อความแจ้งเตือนแก้ได้ที่หน้า "ข้อความแจ้งเตือน" (`crm.phone_reservation.expiring` / `.expired`)

## API (core-service และ external-service `/api/v1/crm/...`)

| | |
|---|---|
| `GET  /opportunities/:id/phone-numbers` | การจองของดีล (ที่ยังจองอยู่ก่อน) + ระยะจอง |
| `GET  /opportunities/:id/phone-numbers/available?contains=&prefix=&category=` | เบอร์ว่าง (ถาม Reserve-phone สด, ≤ 30) |
| `POST /opportunities/:id/phone-numbers` `{numbers[], hold_days?}` | จอง → `{reserved[], failed[{number, reason}]}` |
| `POST /opportunities/:id/phone-numbers/:rid/extend` `{hold_days}` | ต่ออายุ |
| `POST /opportunities/:id/phone-numbers/:rid/release` | ปล่อยคืน |

## ตัวเชื่อม

`RESERVE_PHONE_MODE=mock` (มีแบบเดียว) — ตัวจำลองในหน่วยความจำ คลังเบอร์คงที่ต่อบริษัท
(02-100-xxxx + เบอร์สวย + 086-1xx-xxxx) · restart แล้วการจองในตัวจำลองหาย แต่แถวในระบบยังอยู่
และต่ออายุ/ปล่อยได้ตามปกติ

ตัวเชื่อมจริงยังไม่ทำ เพราะยังไม่ได้สเปก API ของ Reserve-phone — เดาสัญญาเอาเองจะพังเงียบ
ใน production. ตัวเชื่อมจริงต้อง implement `ReservePhoneClient`
(`services/core-service/src/reserve-phone/reserve-phone-client.ts`):

- `search(ctx, {contains, prefix, category, limit})` → เบอร์ว่าง `{number, category, fee}`
- `reserve(ctx, number, {reference: รหัสดีล, expiresAt})` → `{reservationId, number, category, fee, expiresAt}`
  เบอร์ไม่ว่าง = โยน `PhoneNumberUnavailableError`
- `extend(ctx, reservationId, expiresAt)` · `release(ctx, reservationId)` (idempotent)
- `ctx.companyCode` = รหัสบริษัท (ถ้า Reserve-phone แยก pool ต่อบริษัท)
- Reserve-phone ควรปล่อยเบอร์เองเมื่อเลยวันหมดอายุ

สิ่งที่ต้องถามทีม Reserve-phone: URL + วิธี auth, แยก pool ต่อบริษัทหรือไม่, ประเภทเบอร์/ค่าธรรมเนียม,
การจองหมดอายุเองหรือไม่, ตอนเปิดใช้บริการจริง (หลังชนะดีล) ใครเปลี่ยนสถานะเบอร์เป็น "ใช้งาน"
