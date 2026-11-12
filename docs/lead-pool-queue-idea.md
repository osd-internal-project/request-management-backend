# Idea: กองกลาง Lead แบบทีมคิว (ยังไม่ทำ)

สถานะ: **idea** — ผู้ใช้เลือกคงกองกลางแบบเดิมไว้ก่อน (12 พ.ย. 2569, แผน `skill-pstack-crystalline-thacker.md` P3 U6)

## ตอนนี้เป็นอย่างไร

- Lead ที่ยังไม่มีเจ้าของ (`ownerUserId IS NULL`) ทุกคนที่อ่าน Lead ได้ในบริษัทเห็นและหยิบได้ — `visibleLeadsWhere` ใน `libs/share/src/access/sales-rules.ts`
- ไม่มีสิทธิ์ "จัดคน" ของ Lead แยก: ใน OSD คนอ่าน Lead 82 คน ถือ `crm.lead.manage` 81 คน
- กฎจัดทีม (`assignment_rules`, role `sales`) มี 1 กฎ คือ `TEST ลูกค้าธนาคาร → Getter 1`
- ตัวเลข ณ 12 พ.ย. 2569 (DB จริง, SELECT): Lead 106 ใบ, กองกลาง 82 ใบ (OSD_DEMO 56 · OSD_LEAD 23 · OSD 3)

## ความคิด (คำตอบ Q11 ในแผน)

กองกลางเห็นได้เฉพาะ:
1. ทีมคิว — `leads.queueOrgUnitId` = ทีมจาก `AssignmentRule` ที่ตรงตอน Lead เข้า (`crm/leads/intake`, AI agent, ฟอร์มเว็บ)
2. หัวหน้าสายบนของทีมนั้น (หน่วยที่ตัวเองนำ — `ledUnitIds`)
3. คนที่มี `crm.lead.read.all`
4. คนที่มีสิทธิ์ใหม่ `crm.lead.assign` (คนจัดคน)

`queueOrgUnitId` เป็น null (Lead เก่า หรือไม่ตรงกฎไหน) = เห็นได้แค่ข้อ 3–4

## ต้องมีก่อนเปิดใช้

- กฎจัดทีมของ sales ครอบทุกช่องทางที่ Lead เข้า (ตอนนี้มีแค่กฎ TEST)
- ตัดสินว่า role ไหนได้ `crm.lead.assign` (ถ้าไม่ให้ใคร sales ทั่วไปหยิบกองกลางที่ไม่มีทีมคิวไม่ได้)
- backfill `queueOrgUnitId` ของ Lead กองกลางเดิม หรือยอมรับว่ากองกลางเดิมเห็นได้แค่ข้อ 3–4

## งานถ้าทำ

| ชิ้น | ที่ |
|---|---|
| column `queueOrgUnitId String?` + index | `libs/prisma/schema.prisma` model `Lead` + migration (create-only, ถามก่อน apply) |
| ตั้งค่าตอน intake | จุดที่ Lead ถูกสร้าง + `AssignmentService` (`services/core-service/src/assignment/assignment.service.ts`) ที่เลือกกฎอยู่แล้ว |
| กฎการมองเห็น | แทนกิ่ง `{ ownerUserId: null }` ใน `visibleLeadsWhere` ด้วย `{ ownerUserId: null, OR: [ queueOrgUnitId ∈ myUnit ∪ ledUnitIds ] }` + กิ่ง `crm.lead.assign` |
| สิทธิ์ | `crm.lead.assign` ใน `libs/share/src/policy/permissions.ts` + twin `integration.*` ถ้ามี route ภายนอก + migration คัดลอก grant ตาม `docs/permission-taxonomy.md` |
| UI | ตัวกรอง "กองกลางทีมฉัน" + คอลัมน์ "ทีมคิว" ในรายการ Lead (ผ่าน frontend-design) |

## เรื่องเล็กที่ค้างไว้ด้วย

คนที่ถือ `crm.lead.read` แต่ไม่มี `crm.lead.manage` (1 คนใน OSD) ตอนนี้ยังเห็นกองกลาง ทั้งที่หยิบไม่ได้ — ปิดได้ทันทีโดยให้กิ่งกองกลางต้องมี `crm.lead.manage` ถ้าต้องการ
