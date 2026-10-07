# การเบิก (Disbursement) — เงินทดรองจ่าย และเงินสดย่อย

หน้าจออ้างอิง: `../source/request type docs/petty cash/petty cash flow ui /` (`Flow_Advance.png` + ภาพ 1–7, 4b)
แผนงาน: `~/.claude/plans/pasted-content-id-879f-glimmering-dragon.md`

## 1. หลัก: request คือ ticket, การเบิกคือหน้าทำงาน

**ผู้ใช้กำหนด (6 ต.ค. 2569):** request เป็น ticket ที่ถือ lifecycle และ **การอนุมัติทุกขั้น** (หัวหน้า, ผู้บริหาร)
ส่วน "การเบิก" คือหน้าทำงานเรื่องเงินของ ticket นั้น — บัญชีตรวจ, จ่าย, ผู้ขอเคลียร์, ปิด

FI05 (`libs/prisma/seed-petty-cash-type.ts`) เดิมเก็บเงินไว้แค่ใน `formData.expense_items` ไม่มีที่บันทึกการจ่าย
การเคลียร์ หรือการคืนเงิน ข้อมูลเงินจึงแยกมาไว้ที่นี่ (ตาราง + ledger) แต่การขอและการอนุมัติยังเป็นของ request

| ที่มา | เรื่อง |
|---|---|
| source | ลำดับขั้น (`Flow_Advance.png`), ฟอร์มตรวจของบัญชี (ภาพ 4), จ่าย (5), เคลียร์ (6), ปิด/คืนเงิน (7) |
| ผู้ใช้ | request = ticket; FI06 = เบิกเงินสดย่อย จ่ายโดยบัญชีไม่มีเคลียร์; ไฟล์หลักฐานเก็บที่การเบิก |
| ผมเสนอ (แก้ได้) | ผู้อนุมัติขั้นผู้บริหาร = หัวหน้าหน่วย FAC (ภาพ 4b ระบุแค่ CFO); ขั้น `RECEIVE`/`DONE` ตามกลไก flow v2 |
| **ไม่อยู่ในรอบนี้** | กองทุนเงินสดย่อย/ใบเติมเงิน — ไม่มีใน source; ตาราง `petty_cash_*` และ `petty-cash.service.ts` เก็บไว้แต่ไม่มี route |

## 2. ticket (flow v2) — `libs/prisma/disbursement-flows.ts`

```
REQUEST(ร่าง) → HEAD(หัวหน้าอนุมัติ) → RECEIVE(บัญชีรับเรื่อง) → VERIFY(บัญชีตรวจ) → EXEC(ผู้บริหารอนุมัติ)
  → PAY(จ่าย) → CLEAR(เคลียร์, FI05 เท่านั้น) → DONE(ปิดรายการ — ผู้ขอกดปิด)
```

- ขั้นอนุมัติ (`HEAD`, `EXEC`) ตัดสินใน approval inbox ของ request ตามปกติ — ไม่มีเคสอนุมัติของการเบิก
- ขั้นงาน `VERIFY`/`PAY`/`CLEAR` ทำบนหน้าการเบิก: action บันทึกเงินแล้ว `requests.advance` ไปขั้นถัดไป
- flow v2 ต้องจบที่ขั้น `approved` — `DONE` คือผู้ขอเห็นผลแล้วปิด (หลักเดียวกับ ticket อื่น)
- รหัสขั้นอยู่ใน `disbursement_settings` (`verifyStep`, `execStep`, `payStep`, `clearStep`, `doneStep`) — แก้ flow ได้จาก
  flow builder โดยไม่แตะโค้ด ตราบที่รหัสตรงกัน; seed: `yarn disbursement-flow:seed`
- request ที่สร้างก่อนมี flow (ไม่มี `flowVersionId`) เดินแบบเดิม: `verify` = อนุมัติ, `close` เรียก `complete`

## 3. รอยต่อกับ request (`disbursement-request-sync.service.ts`)

| ฝั่ง request | ผลต่อการเบิก |
|---|---|
| `request.submitted` / `resubmitted` | สร้าง (หรือ snapshot ใหม่) — `requestId @unique` |
| `request.step.entered` (event ใหม่, emit ใน `announceV2`) | สถานะตามขั้น: VERIFY → `PENDING_VERIFY`, EXEC → `PENDING_EXEC`, PAY → `APPROVED`, ส่งกลับ → `RETURNED` |
| `request.rejected` / `cancelled` | `REJECTED` / `CANCELLED` |

| Guard บน request | กฎ (`leaveBlocker`) |
|---|---|
| `advance` (ใหม่) ออกจาก VERIFY | ต้องมีผลตรวจบัญชี |
| `advance` ออกจาก PAY | ต้องจ่ายแล้ว (petty: ปิดแล้ว) |
| `advance` ออกจาก CLEAR | ต้องปิดการเบิกแล้ว |
| `cancel` | ห้ามเมื่อเงินออกแล้ว |
| `complete` (request ไม่มี flow) | ห้ามจนการเบิกปิด |

ถอยกลับไม่ถูกกั้น action ของการเบิกบันทึกเงินใน transaction ก่อน แล้วเลื่อน ticket นอก transaction — ถ้าเลื่อนไม่ได้
ผลตอบกลับมี `ticketMove: {moved:false, message}` และผู้ถือ ticket เลื่อนเองได้ (guard ผ่านแล้ว)

## 4. สถานะใบเบิก

```
PENDING_HEAD → PENDING_VERIFY → PENDING_EXEC → APPROVED ─pay→ PAID ─clearing→ CLEARING ─close→ CLOSED
      ↑ RETURNED (ticket ส่งกลับผู้ขอ)                          ↑ returnClearing ┘
REJECTED / CANCELLED จากฝั่ง request · PETTY_CASH: APPROVED ─pay→ CLOSED
```

## 5. กฎเงิน

- `Decimal(14,2)` THB; ยอดขอ = ผลรวม ESTIMATE (คำนวณฝั่ง server)
- `close`: `diff = paid − actual` → คืน (`REFUND`) / เบิกเพิ่ม (`EXTRA_PAY`) ลง movement แล้วปิด; มีส่วนต่างต้องระบุวิธี
- `disbursement_movements` append-only

## 6. ไฟล์หลักฐาน (`disbursement_files`)

`PAYMENT_SLIP` (ผู้มี `disbursement.pay`), `RECEIPT` / `REFUND_PROOF` / `OTHER` (ผู้ขอหรือบัญชี); PDF/JPG/PNG ≤ 10 MB;
ลบ = `deletedAt` **เฉพาะ core-service** — external-service ไม่มี object storage (เหตุผลเดียวกับ e-sign ใน AGENTS.md)

## 7. API (core `disbursements/...`; external `disbursement/disbursements/...` ยกเว้นไฟล์)

| Method | Path | ใคร |
|---|---|---|
| GET | `disbursements`, `:docNo`, `by-request/:requestNo` | ผู้ขอ (ของตัวเอง), `disbursement.read.any` |
| POST | `:docNo/verify` | `disbursement.verify` + ผู้ถือ ticket ที่ขั้น VERIFY |
| POST | `:docNo/pay`, `:docNo/close` | `disbursement.pay` |
| POST | `:docNo/clearing` | ผู้ขอ · `:docNo/clearing/return` — `disbursement.verify` |
| POST/GET/DELETE | `:docNo/files[/:fileId]` | ตาม §6 (core เท่านั้น) |

## 8. ข้อจำกัดที่รู้อยู่

- SLA ของ ticket นับรวมช่วงรอเคลียร์ (flow v2 นับทุกขั้นหลังรับงาน — D7)
- ไม่มีเตือนใกล้/เลยกำหนดเคลียร์ (ต้องมี scheduler)
- LINE: ผู้บริหารได้แจ้งเตือนในระบบ/Teams จากขั้น `EXEC` ของ request
