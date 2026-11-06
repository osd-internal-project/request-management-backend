# ผู้ใช้ที่ทำงานได้แค่ Lead (`sales_lead`)

แผน: `~/.claude/plans/organize-osd-curious-matsumoto.md` · ชื่อสิทธิ์: [`permission-taxonomy.md`](permission-taxonomy.md)
สคริปต์ที่ตรวจตามเอกสารนี้: `scripts/uat-lead-only.ts` (`yarn uat:lead-only`) — แก้ที่นี่ก่อน แล้วค่อยแก้สคริปต์

## 1. role

`sales_lead` = `crm.lead.read` · `crm.lead.manage` · `notification.read`. ไม่มี `employee` (ซึ่งถือ `crm.sales.*` และ `request.*`).
บริษัททดลอง `OSD_LEAD` "OSD (Lead)" สร้างด้วย `yarn lead-company:seed`; ผู้ใช้ `sale.lead@uat.local` ด้วย `yarn user:add --roles sales_lead`.

เห็นเมนู: Lead · บริษัทเป้าหมาย · งานของ AI agent. ไม่เห็น: ดีล ใบเสนอราคา ใบสั่งขาย เป้า รายงานขาย dashboard CRM.
หน้า `/pages` (งานของฉัน) พาไปหน้า Lead เพราะทุกแท็บเป็นรายการคำขอ.

## 2. action

ทุกแถวเรียกผ่าน Open API ในนามผู้ใช้ (`X-Acting-User`) ด้วย key ที่ถือ twin `integration.crm.lead.*` — หน้าจอเรียก route เดียวกันใน core.
"สถานะหลัง" คือสถานะของ Lead. ใครถูกปฏิเสธ = คนที่ไม่มีสิทธิ์ในคอลัมน์สิทธิ์ (หน้าจอซ่อนปุ่ม; API ตอบ 403 `FORBIDDEN`).

| รหัส | action | route | สิทธิ์ | สถานะหลัง | ตอบ |
|---|---|---|---|---|---|
| L01 | ขั้นของ Lead | `GET crm/leads/statuses` | `crm.lead.read` | — | 200 |
| L02 | สร้าง Lead | `POST crm/leads` | `crm.lead.manage` | ขั้นเริ่มต้น (`isDefault`) | 201 |
| L03 | ค้นรายชื่อ | `GET crm/leads?search=` | `crm.lead.read` | — | 200 พบใบที่สร้าง |
| L04 | รายละเอียด | `GET crm/leads/{id}` | `crm.lead.read` | — | 200 |
| L05 | แก้รายละเอียด | `PATCH crm/leads/{id}` | `crm.lead.manage` | เท่าเดิม | 200 |
| L06 | รับเป็นเจ้าของ | `PATCH crm/leads/{id}/owner` `{}` | `crm.lead.manage` | เท่าเดิม, เจ้าของ = ผู้เรียก | 200 |
| L07 | เลื่อนขั้น | `PATCH crm/leads/{id}/status` | `crm.lead.manage` | ขั้น `open` ถัดไป | 200 |
| L08 | intake data | `PATCH crm/leads/{id}/intake-data` | `crm.lead.manage` | เท่าเดิม | 200 |
| L09 | บันทึกกิจกรรม | `POST crm/leads/{id}/activities` | `crm.lead.manage` | เท่าเดิม | 201 |
| L10 | ปิดกิจกรรม | `PATCH crm/leads/{id}/activities/{activityId}` | `crm.lead.manage` | เท่าเดิม | 200 |
| L11 | นำเข้า (ตรวจก่อน) | `POST crm/leads/import` `mode=dry_run` | `crm.lead.manage` | ไม่สร้าง | 201 |
| L12 | นำเข้า (จริง) | `POST crm/leads/import` `mode=commit` | `crm.lead.manage` | ขั้นเริ่มต้น | 201 |
| L13 | ปิดไม่ได้ไปต่อ | `POST crm/leads/{id}/disqualify` | `crm.lead.manage` | `lost` | 201 |
| L14 | แปลงเป็นดีล | `POST crm/leads/{id}/convert` | `crm.lead.manage` | `converted` (ดีลเจ้าของ = ผู้เรียก) | 201 |
| T01 | เพิ่มบริษัทเป้าหมาย | `POST crm/target-accounts` | `crm.lead.manage` | — | 201 |
| T02 | รายการ | `GET crm/target-accounts` | `crm.lead.read` | — | 200 |
| T03 | แก้ | `PATCH crm/target-accounts/{id}` | `crm.lead.manage` | — | 200 |
| T04 | เริ่มเข้าหา → Lead | `POST crm/target-accounts/{id}/approach` | `crm.lead.manage` | Lead ใหม่ | 201 |
| T05 | เลิกเล็ง | `POST crm/target-accounts/{id}/drop` | `crm.lead.manage` | — | 201 |
| T06 | เล็งใหม่ | `POST crm/target-accounts/{id}/reopen` | `crm.lead.manage` | — | 201 |
| A01 | หา Lead ด้วย AI | `POST leads/find` (หน้าจอ) | `crm.lead.manage` | agent record `processing` | 201 |
| A02 | ค้นข้อมูล Lead ด้วย AI | `POST leads/{id}/research` (หน้าจอ) | `crm.lead.manage` | agent record `processing` | 201 |
| A03 | agent อ่าน Lead | `GET crm/ai/leads/{id}` (key ไม่มีคน) | `integration.crm.lead.read.all` | — | 200 |
| A04 | agent ปิดงาน | `PATCH agent-records/{id}` (key ไม่มีคน) | `integration.agent.record.update` | record `done` | 200 |

A01/A02 ไม่มี twin บน Open API — สั่งจากหน้า Lead หรือรายการงานของ agent; สคริปต์รับ id ของ record ที่สั่งไว้แล้วมาปิดงาน (A04).

## 3. ต้องถูกปฏิเสธ

| รหัส | route | เหตุ | ตอบ |
|---|---|---|---|
| X01 | `GET crm/opportunities` | ไม่มี `crm.sales.read` | 403 |
| X02 | `GET crm/quotations` | ไม่มี `crm.sales.read` | 403 |
| X03 | `GET crm/sale-orders` | ไม่มี `crm.sales.read` | 403 |
| X04 | `GET crm/leads/{id}` ของบริษัทอื่น | SCOPE-03 | 404 |

## 4. agent ของบริษัทนี้

ระบบภายนอก "Lead API" (key ที่ Vuvagent ใช้, webhook `lead.*` → Vuvagent, connection `lead.find` / `lead.research`) ย้ายจาก `OSD_DEMO`
มาที่ `OSD_LEAD` เมื่อ 3 พ.ย. 2569 — บริษัทของงาน agent ตัดสินจาก key (`remote-principal.guard.ts`) ไม่ใช่จากสิ่งที่ Vuvagent ส่งมา
agent `lead.find` ของ Vuvagent สร้าง Lead ด้วย key ของ "osd_vuvagent" (`crm/leads/intake`) และปิดงานด้วย key ของ "Lead API" —
คนละ key ในงานเดียว จึงย้าย "osd_vuvagent" (integration, key 2 ใบ, webhook `lead.*`) มาด้วยในวันเดียวกัน.
ทั้งสองไม่มี scope `integration.request.*` / `process.*` / `approval.*` และไม่มี event ของ request — request workflow ของ
`OSD_DEMO` (integration `osd-workflow`) ไม่เกี่ยว. ตั้งแต่นั้น `OSD_DEMO` ไม่มี AI หา/ค้นข้อมูล Lead และไม่มี webhook `lead.*` ไป Vuvagent.
ย้อนกลับ = เปลี่ยน `companyId` ของ integration, key, webhook และ connection ของทั้งสอง integration กลับเป็น `OSD_DEMO`.

4 พ.ย. 2569: รวม key ของ "osd_vuvagent" (`rfk_RqZHNPUm` ที่ใช้งาน กับ `rfk_YlYzApn-` ที่เพิกถอนแล้ว) ไว้ใต้ "Lead API" โดยแก้แค่ `api_keys.integrationId`
ตัว key, scopes และบริษัทเหมือนเดิม Vuvagent จึงไม่ต้องเปลี่ยนอะไร. ปิด webhook `lead-webhook` ที่ซ้ำ (Vuvagent ได้ event ครั้งเดียวแล้ว)
และตั้ง "osd_vuvagent" เป็น inactive. Lead API เปิดแค่ mode `app` และไม่รับ acting user ซึ่งตรงกับการใช้งานจริง (124 calls ก่อนย้ายเป็น `app` ทั้งหมด ไม่มี acting user).
ย้อนกลับ = ตั้ง `integrationId` ของสอง key กลับเป็น osd_vuvagent (`f793b44b-…`) แล้วเปิด integration และ webhook นั้นกลับเป็น active.
