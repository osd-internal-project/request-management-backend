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
| ผู้ใช้ (9 ต.ค. 2569) | FI06 = **จ่ายก่อน เบิกทีหลัง** (ใช้เงินแล้ว ใบเสร็จอยู่ในฟอร์มตอนสร้าง) · หัวหน้าตามสายอนุมัติขั้นเดียว (**ไม่มี `EXEC`**) · บัญชี verify → pay → close · ฟอร์มเพิ่ม `payee` (บังคับ), `so_no`, `so_subject`, `ticket_no`, `project_code` |
| ภาพ FI06 ที่**ไม่ทำตาม** (ผู้ใช้ 9 ต.ค.: ภาพผิด) | `source/request type docs/expense/Petty Cash/LINE_NOTE_261008_1–5.jpg`: "วันที่คาดว่าจะใช้จ่าย", ขั้น 3 "พร้อมใช้งาน", ขั้น 4 เคลียร์/แนบใบเสร็จ, ขั้น 5 "จ่ายคืน/รับคืน" — "เลขที่ Request" ในภาพ = เลขคำขอของตัวเอง ไม่ใช่ช่องกรอก |
| ผมเสนอ (แก้ได้) | ผู้อนุมัติขั้นผู้บริหาร = หัวหน้าหน่วย FAC (ภาพ 4b ระบุแค่ CFO); ขั้น `RECEIVE`/`DONE` ตามกลไก flow v2 |
| **ไม่อยู่ในรอบนี้** | กองทุนเงินสดย่อย/ใบเติมเงิน — ไม่มีใน source; ตาราง `petty_cash_*` และ `petty-cash.service.ts` เก็บไว้แต่ไม่มี route |

## 2. ticket (flow v3) — `libs/prisma/disbursement-flows.ts` `disbursementFlow()`

```
REQUEST(ร่าง) → HEAD(หัวหน้าอนุมัติ) → EXEC(ผู้บริหารอนุมัติ — FI05 เท่านั้น) → RECEIVE(บัญชีรับเรื่อง)
  → DISBURSE(ดำเนินการเบิก: ตรวจ · จ่าย · เคลียร์ · ปิด) → DONE(ปิดรายการ — ผู้ขอกดปิด)
```

| ขั้น | `scope_status` | ใครทำ | action (Open API `requests/{ref}/actions/{action}`) | ไปขั้นถัดไปเมื่อ |
|---|---|---|---|---|
| `REQUEST` | `draft` | ผู้ขอ | `POST request/requests` (สร้าง+ยื่นในครั้งเดียว) | ยื่น |
| `HEAD` | `pending_approval` | หัวหน้าตามสายบังคับบัญชาของผู้ขอ (`supervisor up:1`) | `approve` / `reject` / `send_back` (`note` บังคับทุกตัว) | อนุมัติ |
| `EXEC` (FI05 เท่านั้น — FI06 v4 ขึ้นไป `HEAD` → `RECEIVE`) | `pending_approval` | ผู้อยู่ในหน่วย FAC (`org` = `financeUnitId` ที่ seed ใส่ — แก้ได้ใน flow builder) | เหมือน `HEAD` | อนุมัติ |
| `RECEIVE` | `submitted` | ผู้รับ (`receiverUserId` ที่ผู้ขอเลือก) เท่านั้น | `receive` | **`receive` เลื่อนไป `DISBURSE` เอง** — `advance` ที่ขั้น `submitted` ถูกปฏิเสธ `REQ_STEP_INVALID` |
| `DISBURSE` | `in_progress` | บัญชี (ผู้รับ/ผู้ได้มอบหมาย) | งานทำบนการเบิก §7: `verify` → `pay` → (FI05: `clearing`) → `close` | `close` ของการเบิกเรียก `advance` → `DONE` เอง; `advance` เองถูกกันจนใบเบิก `CLOSED` |
| `DONE` | `approved` | ผู้ขอ (ผู้ถือขั้น) | `advance` `{to_step: "END"}` — flow v2 **ไม่มี** `close` (`REPLACED_BY_FLOW_V2`) | ขั้นสุดท้าย → `finishV2` → คำขอ `closed` |

action ฝั่ง request ที่ใช้ในวงจรนี้ (key scope `integration.request.create` ทุกเส้น):

| action | คน (สิทธิ์) | ใครทำ / ห้ามใคร | สถานะที่รับ | ผลสถานะ | ticket | error |
|---|---|---|---|---|---|---|
| `POST request/requests` | `request.create` | ผู้ขอ | — | `pending_approval` ที่ `HEAD` | สร้าง | 400/422 `REQ_FIELD_MISSING` ฟอร์มขาด · 404 `receiver_user_id` ไม่พบ · 400 ผู้รับนอก `receiver_candidates` |
| `approve` `{note}` | `approval.decide` | ผู้อยู่ใน `candidateUserIds` ของชั้นปัจจุบัน | `pending_approval` | FI05: `HEAD`→`EXEC` ยัง `pending_approval`, `EXEC`→`RECEIVE` = `submitted` · FI06: `HEAD`→`RECEIVE` = `submitted` | เลื่อน | 403 ไม่มีสิทธิ์ · `APV_NOT_YOUR_TURN` ไม่ใช่ผู้อนุมัติชั้นนี้ · `REQ_STATE_INVALID` ไม่ได้รออนุมัติ · 400 ไม่มี `note` |
| `receive` `{}` | `request.complete` | `receiverUserId` เท่านั้น (ไม่มี grant แทน) | `submitted` ที่ `RECEIVE` | `in_progress` ที่ `DISBURSE` + สร้างใบเบิก | เลื่อน | 403 ไม่ใช่ผู้รับ · `REQ_STATE_INVALID` |
| `advance` `{to_step}` | `request.complete` | ผู้ถือขั้น (หรือ scope grant) | ขั้นปัจจุบัน | ขั้นที่ระบุ; ขั้นสุดท้ายส่ง `"END"` = ปิดคำขอ (`closed`) | เลื่อน/จบ | 409 guard §3 · `REQ_STEP_INVALID` ขั้นผิด/ที่ `submitted` (ไปข้างหน้า) |
| `close` `{note?}` | `request.create` | ผู้ยื่นเท่านั้น | `approved` — **เฉพาะคำขอไม่มี flow / flow v1**; flow v2 ไม่เสนอ | `closed` | จบ | 403 `ปิดคำขอได้เฉพาะผู้ยื่นคำขอ` · `REQ_STATE_INVALID` |

- ขั้นอนุมัติตัดสินใน approval inbox ของ request — ไม่มีเคสอนุมัติของการเบิก; ผ่าน Open API ยิง `approve` ในนามผู้อยู่ใน
  `approvalCases[0].steps[ขั้นปัจจุบัน].candidateUserIds` (ขั้นปัจจุบัน = `approvalCases[0].currentStep`)
- รหัสขั้นอยู่ใน `disbursement_settings` (`verifyStep`, `execStep`, `payStep`, `clearStep`, `doneStep`); ขั้นงาน v3 ชื่อคงที่
  `WORK_STEP = 'DISBURSE'`; seed: `yarn disbursement-flow:seed`

### flow เดิม (legacy) — ยังเดินได้สำหรับคำขอที่สร้างไว้แล้ว

`isLegacy()` (`disbursement-request-sync.service.ts` ท้ายไฟล์) = คำขอไม่มี `flowVersionId` **หรือ** flow version ของคำขอมีขั้น
`payStep` (`PAY`) — คำขอเดินตาม version ที่ยื่นไว้ ไม่ย้ายไป v3

```
REQUEST → HEAD → RECEIVE → VERIFY(บัญชีตรวจ) → EXEC → PAY(จ่าย) → CLEAR(FI05) → DONE
```

legacy: ใบเบิกเกิดตอนยื่น, `verify` เลื่อน ticket ไป `EXEC`, `pay` ครบยอดของเงินสดย่อย = `CLOSED` ทันทีแล้วเลื่อน ticket,
คำขอไม่มี flow: `close` เรียก `complete` แทน `advance`; `void` งวดจ่ายใช้ไม่ได้

## 3. รอยต่อกับ request (`disbursement-request-sync.service.ts`)

### ใบเบิกเกิดเมื่อไร (ไม่มีใครต้องกดสร้าง)

| flow | จุดที่สร้าง | สถานะเริ่ม | โค้ด |
|---|---|---|---|
| v3 | ticket เข้าขั้น `DISBURSE` (`request.step.entered`, `status=in_progress`) — คือหลัง `receive` ที่ขั้น `RECEIVE` | `PENDING_VERIFY` + `approvedAt` + `sourceSnapshot` | `onStep` → `createIfDue` |
| legacy | `request.submitted` / `resubmitted` (resubmit = snapshot ยอดใหม่ ถ้าใบยัง `PENDING_HEAD`/`RETURNED`/…) | `PENDING_HEAD` (ถ้าคำขอ `pending_approval`) ไม่งั้น `PENDING_VERIFY` | `onSubmitted`, `startStatus` |

- ใบเบิก 1 ใบต่อคำขอ (`requestId @unique`); ประเภทคำขอ → ชนิดจาก `disbursement_settings` (`advanceTypeCode` → `ADVANCE`, `pettyCashTypeCode` → `PETTY_CASH`)
- ยอดขอ = ผลรวม `expense_items[].amount` (แถวที่อ่านไม่ได้ถูกข้ามและ log ไว้)
- event handler ล้ม = แค่ log (ไม่ย้อน `receive`) → ใบเบิกไม่เกิด → ทางสำรอง `POST disbursements/from-request/{requestNo}`
  (สิทธิ์ `disbursement.pay`; มีใบอยู่แล้วตอบใบเดิม `created:false`; คำขอยังไม่ถึง `DISBURSE` และไม่ใช่ `approved`/`closed` → `CONFLICT`)

### event อื่นจาก request

| ฝั่ง request | ผลต่อการเบิก |
|---|---|
| `request.step.entered` (legacy) | ตามขั้น: `verifyStep` → `PENDING_VERIFY`, `execStep` → `PENDING_EXEC`, `payStep` → `APPROVED`, ร่าง/ส่งกลับ → `RETURNED`, `pending_approval` อื่น → `PENDING_HEAD` (`statusOnStep`) |
| `request.pre_approved` / `returned` / `rejected` / `cancelled` | `PENDING_VERIFY` / `RETURNED` / `REJECTED` / `CANCELLED` — เฉพาะที่ย้ายได้จากสถานะปัจจุบัน (`statusOnRequestEvent`) |

### guard ที่การเบิกติดไว้บน request (`addGuard`)

| action ของ request | กฎ | error |
|---|---|---|
| `advance` ออกจาก `DISBURSE` (v3, ไปข้างหน้า) | ใบเบิกต้อง `CLOSED` | `CONFLICT` "ใบเบิก … ยังไม่ปิด" |
| `advance` ออกจาก `VERIFY` (legacy) | ต้องมีผลตรวจบัญชี | `CONFLICT` |
| `advance` ออกจาก `PAY` (legacy) | จ่ายแล้ว (petty: `CLOSED`) | `CONFLICT` |
| `advance` ออกจาก `CLEAR` (legacy) | `CLOSED` | `CONFLICT` |
| `cancel` | ห้ามเมื่อเงินออกแล้ว (`PARTIALLY_PAID`/`PAID`/`CLEARING`/`CLOSED`) | `CONFLICT` |
| `complete` (คำขอไม่มี flow) | ใบเบิกต้อง `CLOSED` | `CONFLICT` |

ถอยกลับไม่ถูกกั้น action ของการเบิกบันทึกเงินใน transaction ก่อน แล้วเลื่อน ticket นอก transaction — ถ้าเลื่อนไม่ได้
ผลตอบกลับมี `ticketMove: {moved:false, message}` และผู้ถือ ticket เลื่อนเองได้ (guard ผ่านแล้ว)

## 4. สถานะใบเบิก

### v3 (ใบเบิกเกิดหลังอนุมัติครบ — ไม่มี `PENDING_HEAD`/`PENDING_EXEC`)

```
ADVANCE:    PENDING_VERIFY ─verify→ APPROVED ─pay→ PARTIALLY_PAID ─pay→ PAID ─clearing→ CLEARING ─close→ CLOSED
                                                                      ↑ clearing/return ┘
PETTY_CASH: PENDING_VERIFY ─verify→ APPROVED ─pay→ PARTIALLY_PAID ─pay→ PAID ─close→ CLOSED   (ไม่มีเคลียร์)
void งวดจ่าย: สถานะตามยอดที่เหลือ (PAID/PARTIALLY_PAID → PARTIALLY_PAID/APPROVED)
```

| action | v3 ADVANCE | v3 PETTY_CASH | ticket เลื่อน (`ticketMove`) |
|---|---|---|---|
| `verify` | → `APPROVED` | → `APPROVED` | `null` — อยู่ `DISBURSE` |
| `pay` | → `PARTIALLY_PAID`/`PAID` | → `PARTIALLY_PAID`/`PAID` (**ไม่ปิดเอง**) | `null` |
| `clearing` | `PAID` → `CLEARING` | ไม่มี (`moveBlocker`) | ไม่มีฟิลด์ |
| `close` (บัญชีเคลียร์เอกสาร — Complete) | `CLEARING` → `CLOSED` + คิดส่วนต่าง; มีส่วนต่างต้องมีสลิป (§5) | `PAID` → `CLOSED` | `advance` → `doneStep` (`DONE`) ในนามผู้กด; ล้ม → `moved:false` |

### legacy

```
PENDING_HEAD → PENDING_VERIFY → PENDING_EXEC → APPROVED ─pay→ PAID ─clearing→ CLEARING ─close→ CLOSED
      ↑ RETURNED (ticket ส่งกลับผู้ขอ)                          ↑ returnClearing ┘
REJECTED / CANCELLED จากฝั่ง request · PETTY_CASH: APPROVED ─pay ครบยอด→ CLOSED
```

## 5. กฎเงิน

- `Decimal(14,2)` THB; ยอดขอ = ผลรวม ESTIMATE (คำนวณฝั่ง server)
- `close` (ขั้น **บัญชีเคลียร์เอกสาร**: Complete หรือ `clearing/return` = ตีกลับ): `diff = paid − actual` (`settlement()`)

  | กรณี | ตัวอย่าง | ใครทำอะไร | สลิปที่ต้องมีก่อน Complete | movement |
  |---|---|---|---|---|
  | เบิกเกิน (ใช้น้อยกว่า) | ได้ 5,000 ใช้ 4,500 | ผู้ขอคืน 500; บัญชียืนยันรับแล้ว Complete | `REFUND_PROOF` | `REFUND +500` |
  | ใช้เกิน | ได้ 5,000 ใช้ 5,800 | บัญชีโอนส่วนต่าง 800 ให้ผู้ขอแล้ว Complete | `PAYMENT_SLIP` | `EXTRA_PAY −800` |
  | พอดี | ได้ 5,000 ใช้ 5,000 | Complete ได้เลย | — | — |

  มีส่วนต่างต้องส่ง `method`; สลิปนับเฉพาะไฟล์ที่แนบ**หลังส่งเคลียร์ครั้งล่าสุด** (`uploadedAt ≥ clearingAt`, ไม่ถูกลบ) — ตีกลับแล้วผู้ขอส่งใหม่
  = ส่วนต่างคำนวณใหม่และต้องแนบสลิปใหม่ (`settlementEvidence()`); movement เก็บ `evidenceFileKey` ของสลิปที่ใช้
- `disbursement_movements` append-only

## 6. ไฟล์หลักฐาน (`disbursement_files`)

`PAYMENT_SLIP` (ผู้มี `disbursement.pay` — สลิปจ่ายงวด และสลิปจ่ายส่วนต่างที่ใช้เกิน), `RECEIPT` / `REFUND_PROOF` (หลักฐานรับคืน) / `OTHER` (ผู้ขอหรือบัญชี); PDF/JPG/PNG ≤ 10 MB;
ลบ = `deletedAt` **เฉพาะ core-service** — external-service ไม่มี object storage (เหตุผลเดียวกับ e-sign ใน AGENTS.md)

## 7. API (core `disbursements/...`; external `disbursement/disbursements/...` ยกเว้นไฟล์)

สิทธิ์สองชั้นบน Open API: กุญแจต้องมี scope (คอลัมน์ "key") **และ** คนใน `X-Acting-User` ต้องมีสิทธิ์เดียวกับหน้าจอ (คอลัมน์ "คน")
ทุก action อ่านใบเบิกผ่าน `visibleWhere` ก่อน — มองไม่เห็น = `404 NOT_FOUND` (ไม่ใช่ 403)

| Method · Path | key | คน | ใครทำ / ห้ามใคร | สถานะที่รับ | ผลสถานะ | ticket เลื่อน | error |
|---|---|---|---|---|---|---|---|
| GET `disbursements` · `:docNo` · `by-request/:requestNo` | `integration.disbursement.read` | `request.read` | เห็น: ผู้ขอ (ของตัวเอง); `disbursement.read.any` หรือ `disbursement.pay` เห็นทั้งบริษัท; คนอื่นเห็นเท่าคำขอที่ตัวเองเห็น | ทุกสถานะ | — | — | 404 |
| POST `from-request/:requestNo` (ทางสำรอง §3) | `…manage` | `disbursement.pay` | บัญชี | คำขออยู่ `DISBURSE` หรือ `approved`/`closed` | สร้าง `PENDING_VERIFY` หรือตอบใบเดิม (`created`) | — | 404, 409 ยังไม่ถึงขั้น / ประเภทไม่ผูกการเบิก |
| POST `:docNo/verify` `{checked_cost_center, checked_documents, checked_authority, note}` (ครบ 4 ช่อง) | `…manage` | `disbursement.verify` | ผู้รับหรือผู้ได้มอบหมายของคำขอ; **ห้ามผู้ขอ** | `PENDING_VERIFY` + คำขอ `in_progress` ที่ `DISBURSE` (legacy: `verifyStep`) | `APPROVED` (legacy มี flow: เลื่อน ticket → `EXEC`) | v3 `null` | 409 สถานะ/ยังไม่ receive/ผิดขั้น · 403 ผู้ขอ/ไม่ใช่ผู้ถือ · 400 ช่องขาด |
| POST `:docNo/pay` `{amount, method, paid_at?, reference?}` | `…manage` | `disbursement.pay` | บัญชี (ไม่ตรวจว่าถือ ticket); **ห้ามผู้ขอ** | `APPROVED` / `PARTIALLY_PAID` | ตามยอดสะสม: `PARTIALLY_PAID`/`PAID` (legacy petty ครบยอด = `CLOSED`) + movement `PAYOUT` (ติดลบ) | v3 `null` | 409 สถานะ · 403 ผู้ขอ · 400 `amount` ≤ 0 หรือเกินยอดคงเหลือ, `method` ∉ `transfer/cash/cheque` |
| POST `:docNo/payments/:movementId/void` `{reason}` | `…manage` | `disbursement.pay` | เจ้าหน้าที่**คนอื่น** ไม่ใช่ผู้จ่ายงวดนั้น; ห้ามผู้ขอ | `PARTIALLY_PAID` / `PAID`, ไม่ใช่ legacy | ตามยอดที่เหลือ + movement `PAYOUT_VOID` | — | 409 สถานะ/legacy/ยกเลิกซ้ำ · 403 ผู้จ่ายเอง/ผู้ขอ · 404 งวด |
| POST `:docNo/clearing` `{items:[{description, amount, cost_center?, note?, receipt_date?}]}` | `…manage` | `request.create` | **ผู้ขอเท่านั้น** | `PAID` (ADVANCE) — ส่งซ้ำแทนที่ ACTUAL เดิม | `CLEARING` | — | 403 ไม่ใช่ผู้ขอ · 409 สถานะ/เป็นเงินสดย่อย · 400 รายการ |
| POST `:docNo/clearing/return` `{reason}` | `…manage` | `disbursement.verify` | บัญชี | `CLEARING` | `PAID` | — | 409 |
| POST `:docNo/close` `{method?, reference?, occurred_at?, counterparty_user_id?}` | `…manage` | `disbursement.pay` | บัญชี; **ห้ามผู้ขอ** | ADVANCE `CLEARING` (+ สลิปตาม §5 เมื่อมีส่วนต่าง) · PETTY_CASH `PAID` | `CLOSED`; ADVANCE มีส่วนต่าง → movement `REFUND`/`EXTRA_PAY` + `evidenceFileKey` | **ใช่** → `DONE` (ไม่มี flow: `complete`); ล้ม → `moved:false` + `message` | 409 สถานะ · 403 ผู้ขอ · 400 มีส่วนต่างแต่ไม่ส่ง `method` · 400 ไม่มีสลิป (`field: files`, `reason: REFUND_PROOF`/`PAYMENT_SLIP`) |
| POST/GET/DELETE `:docNo/files[/:fileId]` | core เท่านั้น | `request.read` | ตาม §6 | — | — | — | — |

`ticketMove` คืนเฉพาะ `verify`/`pay`/`close` (ค่า `null` = ไม่ได้พยายามเลื่อน); `detail` มี `legacy`, `movements`, `files`, `ticket {status, stepCode, assigneeUserId}`

## 8. ข้อจำกัดที่รู้อยู่

- SLA ของ ticket นับรวมช่วงรอเคลียร์ (flow v2 นับทุกขั้นหลังรับงาน — D7)
- ไม่มีเตือนใกล้/เลยกำหนดเคลียร์ (ต้องมี scheduler)
- LINE: ผู้บริหารได้แจ้งเตือนในระบบ/Teams จากขั้น `EXEC` ของ request
- `paid_at` (`pay`) / `occurred_at` (`close`) ตรวจด้วย `@IsDateString()` ซึ่งรับ datetime เต็ม แต่โค้ดต่อ `T00:00:00Z` เอง —
  ส่ง datetime ได้วันที่เสีย ต้องส่ง `YYYY-MM-DD` เท่านั้น (ยังไม่แก้)
- `pay` ไม่ตรวจว่าผู้กดถือ ticket (ตรวจแค่สิทธิ์ `disbursement.pay` + ไม่ใช่ผู้ขอ) ต่างจาก `verify`
- action `approve`/`reject`/`send_back` ของ Open API คืน**เคสอนุมัติ** (`ApprovalsService.decide` → `CaseWithSteps`) ไม่ใช่คำขอ
  ต่างจากที่ `external-request.json` บอก — อ่านสถานะคำขอต่อด้วย `GET request/requests/{ref}`
- `close` เลื่อน ticket ในนามผู้กด — ถ้าผู้กดไม่ใช่ผู้ถือ ticket ที่ `DISBURSE` ได้ `ticketMove.moved:false` ให้ผู้ถือกด `advance` เอง
- ช่อง `cost_center` ในฟอร์มขั้น `REQUEST` (FI06; FI05 เมื่อฟอร์มมีช่องนี้) ต้องเป็นค่าใน master `cost_centers` — master ว่าง = ยื่นไม่ได้ทุกช่องทาง (`.55` ว่างจนถึง 9 ต.ค. 2569);
  `GET request-types/{code}/form` ของ Open API ไม่ส่งตัวเลือกนี้ (อ่านฟอร์มของ type ไม่ใช่ขั้น `REQUEST`)
- `POST request/requests` ที่ตอบ `422` (ฟอร์มไม่ครบ, ไม่มี `ref_id`) ทิ้งคำขอ `draft` ที่ไม่มี `requestNo` ไว้ และคำตอบไม่บอก id (ยังไม่แก้)

## 9. UAT ผ่าน Open API — ครบวงจร

**รันทั้งหมดด้วยสคริปต์** (`scripts/uat-disbursement.ts` — ข้อ 01–16, A1–A4 และเคสลบด้านล่าง ตรวจ status, `code`, ขั้น, สถานะใบเบิก, movement):

```
API_KEY=rfk_… REQUESTER=<ผู้ขอ> HEAD=<หัวหน้าของผู้ขอ> EXEC=<คนใน FAC> ACCOUNTING=<บัญชี: receiver + finance> \
COST_CENTER=<รหัสใน master> [ONLY=FI06|FI05] [BASE_URL=http://localhost:3003/api/v1] yarn uat:disbursement
```

สร้างคำขอจริง 4 ใบและไม่ลบ; ชุด "FI05 มีส่วนต่าง" ตั้งใจค้าง `CLEARING` ให้แนบ `REFUND_PROOF` ที่หน้าเว็บแล้วปิดเอง.
ผล 9 ต.ค. 2569 (localhost → `.55`): FI05 ทุกข้อผ่าน, FI06 57/57 — หลังเพิ่ม cost center `RND` (master ว่าง)

ตัวอย่าง request/response ทุก call: [`ex/uat-disbursement-open-api/`](./ex/uat-disbursement-open-api/) (`NN-<step>.request.json` / `.response.json`)
ค่าในตัวอย่างเป็น placeholder (`<requestNo>`, `<docNo>`, `<uuid:waranyas>`) — ตอนรันเทียบรูปร่างและสถานะ ไม่เทียบค่า

### เตรียม

- base: `http://<external-service>:3503/api/v1` · header ทุกเส้น: `Authorization: Bearer rfk_…`, `X-Acting-User: <อีเมล>`
  (ตรงตัวพิมพ์กับ `users.email` และต้องเคย login เว็บ ไม่งั้น `404`), POST ใส่ `Idempotency-Key` หนึ่งค่าต่อหนึ่งเจตนา
- scope ของกุญแจ: `integration.request.create`, `integration.disbursement.read`, `integration.disbursement.manage`
- สิทธิ์คน: ผู้ขอ `request.create` + `request.read`; หัวหน้า/ผู้บริหาร `approval.decide`; บัญชี `request.complete` (receive)
  + `disbursement.verify` + `disbursement.pay` + `request.read`
- **บัญชีผู้รับต้องถือ `receiver` (รับเรื่อง: `request.complete`) + `finance` (`disbursement.verify` + `disbursement.pay`)** —
  ขาด `finance` ข้อ 11 ได้ `403 FORBIDDEN` `details: [{field: permission, reason: disbursement.verify}]`. seed เพิ่มสิทธิ์การเบิกให้ `finance`
  เมื่อ 7 ต.ค. 2569; DB ที่สร้าง role ด้วยมือต้องมี role `finance` เอง (บน .55 สร้างแล้ว 7 ต.ค. 2569) — UAT ใช้ role จริงเท่านั้น ห้ามสร้าง role ทดสอบ
- **รู้เวอร์ชัน flow ได้หลังสร้างคำขอเท่านั้น**: ข้อ 5 `flow_moves` ที่ขั้น `HEAD` — `forward` (string ไม่ใช่ array):
  FI05 `EXEC` = v3, `RECEIVE` = legacy · FI06 `RECEIVE` ทั้งคู่ (v4 ตัด `EXEC`) → ดูที่ข้อ 10 แทน: `legacy: false` และขั้น `DISBURSE`
- **Cost Center ต้องอยู่ใน master** (`x-options-source: cost_centers` บนฟอร์มขั้น `REQUEST`) แต่ `GET request-types/{code}/form` คืนฟอร์มของ type
  ที่ไม่มีตัวเลือก — ผู้เรียกต้องรู้รหัสเอง (§8)
- เงินที่อ่านจาก DB เป็น string ไม่เติมศูนย์ (`"850"`, `"-850"`); ค่าที่คำนวณสด (`pending`, ข้อความ error) เป็น 2 ตำแหน่ง
- ที่ `RECEIVE` ผู้รับเห็น `receive`, `assign`, `advance` — `advance` ใช้ถอยกลับ `REQUEST` เท่านั้น ไปข้างหน้าด้วย `receive`
  (Open API ไม่มีเส้นอ่าน flow ของประเภทคำขอ)
- ก่อนทุก action เรียก `GET request/requests/{ref}/actions` ในนามคนที่จะทำ และยิงเฉพาะ action ที่ตอบมา

### FI06 เงินสดย่อย (v3)

| # | ในนาม | call | คาดหวัง |
|---|---|---|---|
| 01 | ผู้ขอ | `GET request/request-types?q=FI06` | มี `FI06` |
| 02 | ผู้ขอ | `GET request/request-types/FI06/form` | `form_schema.required` = `cost_center, payee, purpose, expense_items` (+ ไม่บังคับ `so_no, so_subject, ticket_no, project_code`); แถวต้องมี `receipt_date, description, amount`; `receiver_candidates` มีบัญชี (หน่วย FAC) |
| 03 | ผู้ขอ | `GET request/users?q=<บัญชี>` | `data[0].id` = uuid ผู้รับ (หรือใช้ `receiver_candidates[].id` จากข้อ 02) |
| 04 | ผู้ขอ | `POST request/requests` `{type_code, receiver_user_id, form_data}` | 201 `status: pending_approval`, ได้ `requestNo` |
| 05 | ผู้ขอ | `GET request/requests/{no}` + `GET …/actions` | `approvalCases[0].steps[currentStep].candidateUserIds` = หัวหน้า; `flow_moves.current = HEAD` |
| 06 | หัวหน้า | `POST …/actions/approve` `{note}` | `status: submitted`, ขั้น `RECEIVE` — ไม่มี `EXEC` (flow FI06 v4, 9 ต.ค. 2569; ตัวอย่าง `07-approve-exec` ใช้กับ FI05 เท่านั้น) |
| 08 | บัญชี | `GET …/actions` | มี `receive` (ผู้รับเท่านั้น) |
| 09 | บัญชี | `POST …/actions/receive` `{}` | `status: in_progress`, ขั้น `DISBURSE` **เอง** — ไม่ยิง `advance` |
| 10 | บัญชี | `GET disbursement/disbursements/by-request/{no}` | ใบเบิกเกิดเองแล้ว: `kind: PETTY_CASH`, `status: PENDING_VERIFY`, `requestedAmount` = ผลรวมแถว, `legacy: false`, `payee` / `references` ตามฟอร์ม — 404 = handler ล้ม (§3 ทางสำรอง) |
| 11 | บัญชี | `POST …/{docNo}/verify` | `APPROVED`, `ticketMove: null` |
| 12 | บัญชี | `POST …/{docNo}/pay` `{amount: ยอดเต็ม, method: "cash"}` | `PAID` (ไม่ใช่ `CLOSED`), movement `PAYOUT` ยอดติดลบ, `ticketMove: null` |
| 13 | บัญชี | `POST …/{docNo}/close` `{}` | `CLOSED`, `ticketMove.moved: true` — คำขอไปขั้น `DONE` (`approved`) |
| 14 | ผู้ขอ | `GET …/actions` | `flow_moves.current = DONE`, `is_last: true`, `forward: null`, `holder_user_id` = ผู้ขอ; มี `advance` (ไม่มี `close`) |
| 15 | ผู้ขอ | `POST …/actions/advance` `{"to_step": "END"}` | `status: closed`, `closedAt` มีค่า |
| 16 | ผู้ขอ | `GET disbursement/disbursements/{docNo}` | `CLOSED`, movement 1 รายการ, `ticket.status: closed` |

เคสลบ (ไม่เปลี่ยนสถานะ): N1 `verify` ในนามผู้ขอ → `403 FORBIDDEN` · N2 `pay` ขณะ `PENDING_VERIFY` → `409 CONFLICT` ·
N3 `pay` เกินยอด → `400 VALIDATION_FAILED` (`field: amount`) · N4 ผู้ขอที่ขั้น `DISBURSE` → actions มีแค่ `cancel`, `comment` (ปิดเองไม่ได้; `cancel` หลังเงินออกถูก guard 409) ·
N5 `close` ที่ `APPROVED` → `409` · N6 ผู้ขอส่ง `clearing` → `409` "เงินสดย่อยไม่มีขั้นเคลียร์ค่าใช้จ่าย" · N7 บัญชี `advance` ไป `DONE` ก่อนใบเบิก `CLOSED` → `409` ·
N8 หัวหน้า `reject` → คำขอ `rejected`, `by-request` → `404` (ใบเบิกไม่เกิด)

### FI05 เงินทดรอง (v3) — ข้อ 01–11 เหมือน FI06 แล้วต่างจากนี้

- **อ่านฟอร์มจาก `GET request/request-types/FI05/form` เสมอ ไม่ใช่จาก seed** — ผู้ดูแลแก้ฟอร์มผ่านหน้าจอได้
  (UAT 7 ต.ค. 2569 บน .55: บังคับ `needed_by, clear_by, purpose, expense_items, account, backname`; แถวบังคับ `description, amount`;
  seed `seed-petty-cash-type.ts` บังคับชุดอื่น)
- FI05 ตอบ `ref_required: true` → ข้อ 04 ต้องส่ง `ref_type` + `ref_id` (นอก `form_data`); โค้ดตรวจแค่ `ref_id` ไม่ว่าง (`submit-rules.ts`)
  ไม่ส่ง → `422 REQ_FIELD_MISSING` field `ref_id`
- ใบเบิกได้ `kind: ADVANCE`, เลข `ADV-…`, `clearBy` จาก `clear_by`

| # | ในนาม | call | คาดหวัง |
|---|---|---|---|
| A1 | บัญชี | `POST …/{docNo}/pay` `{amount: ยอดเต็ม, method: "transfer", reference, paid_at}` | `PAID`, movement `PAYOUT` ติดลบ, `ticketMove: null` |
| A2 | ผู้ขอ | `POST …/{docNo}/clearing` `{items:[{description, amount, receipt_date?}]}` | `CLEARING`, `actualAmount` = ผลรวม, `pending: {refund, extraPay}` |
| A2b | บัญชี | `POST …/{docNo}/clearing/return` `{reason}` (ถ้าเอกสารไม่ผ่าน) | กลับ `PAID`; ผู้ขอส่ง A2 ใหม่ → แถว ACTUAL ถูกแทนที่ทั้งชุด |
| A3 | บัญชี | ก่อนเรียก: แนบสลิปที่**หน้าเว็บ** (คืน = `REFUND_PROOF`, เพิ่ม = `PAYMENT_SLIP`) แล้ว `POST …/{docNo}/close` `{method, occurred_at?}` | `CLOSED`, movement `REFUND` (+) หรือ `EXTRA_PAY` (−) มี `evidenceFileKey`, `counterpartyUserId` = ผู้ขอ, `ticketMove.moved: true` → `DONE` |
| A4 | ผู้ขอ | `POST …/actions/advance` `{"to_step": "END"}` | คำขอ `closed` |

เคสลบ FI05: FN5 ผู้ขอ `clearing` ก่อนจ่าย → `409` "ใบเบิกสถานะ PENDING_VERIFY ทำรายการนี้ไม่ได้" ·
FN6 `close` ก่อนเคลียร์ → `409` "ปิดได้เฉพาะเงินทดรองที่ส่งเคลียร์แล้ว" · FN7 บัญชีส่ง `clearing` แทน → `403` "เฉพาะผู้ขอเบิกเท่านั้นที่ส่งเคลียร์ได้" ·
FN8 `close` มีส่วนต่างแต่ไม่ส่ง `method` → `400 VALIDATION_FAILED` field `method` ·
FN9 `close` มีส่วนต่าง ส่ง `method` แต่ยังไม่แนบสลิป → `400 VALIDATION_FAILED` `details: [{field: files, reason: REFUND_PROOF}]`

`approvalCases` คืนเฉพาะเคสล่าสุด (`orderBy createdAt desc, take 1` — `request.repository.ts`) จึงอ่าน `[0]` ได้ทุกขั้นอนุมัติ
