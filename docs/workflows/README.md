# Workflow แบบประกอบ: sub-flow → ประเภทคำขอ

เอกสารชุดนี้แยกงานของระบบคำขอออกเป็น **sub-flow** ย่อย ๆ ที่หยิบมาใช้ซ้ำได้ เช่น สร้าง ยื่น อนุมัติ ยกเลิก ดู และค้นหา
แล้วเขียนแต่ละประเภทคำขอเป็น**การประกอบ** sub-flow เหล่านั้น
ตัวอย่าง: FI05 = sub-flow ของคำขอ + sub-flow ของการเบิก

เนื้อหายึดตามโค้ดปัจจุบัน (27 ต.ค. 2569) ส่วนที่ SOP หรือแผนผังมีแต่ระบบยังไม่มี ติดป้าย `PROPOSED`
ภาพรวมแบบโต้ตอบได้อยู่ที่ artifact [Request Flow Map](https://claude.ai/artifact/Vodi4MzodoMaa3mskF3Yuw)
ใน artifact นั้น webhook ยังติดป้าย `PROPOSED` อยู่ แต่ในโค้ดตอนนี้มีแล้ว (`webhook-delivery.service.ts`)

## ไฟล์

| ไฟล์ | เนื้อหา |
|---|---|
| [sub/request.md](sub/request.md) | `REQ-*` 18 ตัว ใช้กับคำขอทุกประเภท |
| [sub/disbursement.md](sub/disbursement.md) | `DISB-*` 8 ตัว เป็นงานเงินบนใบเบิก ใช้กับ FI05 / FI06 |
| [sub/docreq.md](sub/docreq.md) | `DOC-*` 6 ตัว เป็นงานของผู้ดูแลเอกสาร ใช้กับ SOP_DOCREQ |
| [types/GENERAL.md](types/GENERAL.md) | คำขอทั่วไป (type ที่ไม่มี flow เช่น BS-01, PS01) = ยื่น → รับเรื่อง → ทำงาน → ส่งงาน → ผู้ขอปิด |
| [types/FI05.md](types/FI05.md) | เงินทดรองจ่าย = REQ + DISB (มีเคลียร์) |
| [types/FI06.md](types/FI06.md) | เงินสดย่อย = REQ + DISB (ไม่มีเคลียร์) |
| [types/SOP_DOCREQ.md](types/SOP_DOCREQ.md) | ขอใช้เอกสารสำคัญ = REQ + DOC |

## ตาราง ประเภท × sub-flow

`●` อยู่บนเส้นหลัก · `○` ใช้ได้เมื่อต้องการ / ทางออกนอกเส้นหลัก · `—` ไม่ใช้

| sub-flow | GENERAL | FI05 | FI06 | SOP_DOCREQ |
|---|---|---|---|---|
| REQ-IDENTIFY | ● | ● | ● | ● |
| REQ-CREATE | ● | ● | ● | ● |
| REQ-SUBMIT | ● | ● | ● | ● |
| REQ-APPROVE | ○ เมื่อ type มี matrix | ● `HEAD`, `EXEC` | ● `HEAD` | ● `SUPERVISOR_APPROVAL` |
| REQ-RECEIVE | ● `receive` | ● `RECEIVE` | ● `RECEIVE` | ● `RECEIVE` |
| REQ-ASSIGN | ○ | ○ | ○ | ○ |
| REQ-STEP-FORM | — | — | — | ● `PREPARE` … `STAMP_DELIVER` |
| REQ-ADVANCE | — ใช้ `complete` แทน | ● ระบบเรียกให้ตอน DISB-CLOSE · ผู้ขอที่ `DONE` | ● เหมือน FI05 | ● ทุกขั้นงาน |
| REQ-RETURN | ○ `return` · `resubmit` | ○ `RECEIVE` → `REQUEST` | ○ เหมือน FI05 | ○ `RECEIVE` → `REQUEST`, `STAMP_DELIVER` → `PREPARE` |
| REQ-HOLD | ○ | ○ | ○ | ○ |
| REQ-CANCEL | ○ | ○ ก่อนเงินออก | ○ ก่อนเงินออก | ○ |
| REQ-CLOSE | ● `close` | ● `DONE` | ● `DONE` | ● `SIGNED_CONFIRM` |
| REQ-VIEW · REQ-SEARCH | ● หางานก่อนทำ | ○ | ○ | ○ |
| REQ-COMMENT · REQ-NOTIFY | ○ | ○ | ○ | ○ |
| REQ-ATTACH | ○ | ○ | ○ | ● `SIGNED_DOCUMENT` |
| REQ-CHILD | ○ | ○ | ○ | ○ |
| DISB-CREATE · VERIFY · PAY · CLOSE | — | ● | ● | — |
| DISB-CLEAR | — | ● | — | — |
| DISB-CANCEL · FILE · VIEW | — | ○ | ○ | — |
| DOC-PREPARE · STAMP-DELIVER · SIGNED-CONFIRM | — | — | — | ● |
| DOC-CERT-CHECK · CERT-REISSUE | — | — | — | ○ ตามทางแยก |
| DOC-REGISTER | — | — | — | ○ นอก flow |

## วิธีอ่าน

แต่ละ sub-flow มีรูปแบบเดียวกัน

1. **หัวเรื่อง** `## REQ-XXX` (ใช้เป็น anchor ได้ เช่น `sub/request.md#req-cancel`)
2. **บรรทัดสรุป**: ทำอะไร · ใครทำ · เริ่มเมื่อไร
3. **ผัง Mermaid** (เฉพาะ sub-flow ที่มีทางแยก)
4. **ตาราง** `ขั้น | ใครทำ | API / MCP | เข้า | ออก | guard | สถานะหลังทำ`
5. **ผลข้างเคียง** (event, SLA, เลขที่) และ `PROPOSED`

สัญลักษณ์ในผัง

| รูป | ความหมาย |
|---|---|
| `([ ... ])` | สถานะ หรือจุดเริ่ม / จุดจบ |
| `[ ... ]` | งานหนึ่งขั้น |
| `{ ... }` | ทางแยก |
| `[[ ... ]]` | event หรือ sub-flow อื่น |
| เส้นทึบ | เส้นหลัก |
| เส้นประ `-.->` | ถอยกลับ / ส่งกลับ |

ชื่อ API
- `actions/<action>` ย่อมาจาก Open API `POST request/requests/:ref/actions/:action` และ MCP `request_post_requests_ref_actions_action`
- `core …` คือ route ของหน้าเว็บ (core-service) ที่ Open API ยังไม่มี
- Open API ทุก route ต้องระบุคนด้วย [REQ-IDENTIFY](sub/request.md#req-identify)

## วิธีประกอบประเภทใหม่

1. เขียน flow v2 (`schema_version: 2`) โดยกำหนด `scope_status` ให้ทุกขั้น ขั้นแรกเป็น `draft` และขั้นสุดท้ายเป็น `approved`
2. จับคู่แต่ละขั้นกับ sub-flow: `draft` → REQ-CREATE / SUBMIT · `pending_approval` → REQ-APPROVE · `submitted` → REQ-RECEIVE · `in_progress` → REQ-STEP-FORM + REQ-ADVANCE หรือ sub-flow ของโมดูล · `approved` → REQ-CLOSE
3. ถ้างานมีข้อมูลของตัวเอง เช่น เงิน ให้สร้างโมดูลปลายทาง (แบบ DISB) ที่เกิดจาก event และผูกกับคำขอด้วย `requestId` แล้วให้คำขอรออยู่ที่ขั้นงานขั้นเดียว อย่าเพิ่มงานของโมดูลเป็นขั้นของคำขอ (`request-management-backend/AGENTS.md`)
4. เขียน `types/<CODE>.md` ตามแบบ FI05: ลำดับการประกอบ · ทางออกนอกเส้นหลัก · ใครทำอะไร · ฟอร์ม · `PROPOSED`

## เอกสารที่เกี่ยวข้อง

- [system-overview/04-chat-workflow.md](../system-overview/04-chat-workflow.md): บทสนทนาในแชท C-01…C-23 (sub-flow แต่ละตัวอ้างหมายเลข C ไว้)
- [request-management-backend/docs/disbursement.md](../../request-management-backend/docs/disbursement.md): กติกาการเบิกฉบับเต็ม
- [request-management-backend/docs/EXTERNAL_API_INDEX.md](../../request-management-backend/docs/EXTERNAL_API_INDEX.md): Open API ทุก route
