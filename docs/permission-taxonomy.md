# ชื่อสิทธิ์ (permission taxonomy)

แผนงาน: `~/.claude/plans/permission-split-all-modules.md` (ร่าง) · ตัวอย่างแรก: `crm.lead.*` (`~/.claude/plans/organize-osd-curious-matsumoto.md`)

## 1. รูปแบบ

```
<module>.<module ย่อย>.<action>
```

| action | ความหมาย |
|---|---|
| `read` | ดูแถวของตัวเอง ทีม และหน่วยที่ได้รับ scope |
| `read.all` | ดูทั้งบริษัท |
| `manage` | สร้าง แก้ ปิด |
| verb เฉพาะทาง | คงชื่อเดิม เช่น `financial.read`, `sensitive.read`, `dedup.override`, `override`, `pay`, `verify` |

- **หนึ่ง module ย่อยต่อหนึ่งงานที่ role ต้องแยกได้** — ถ้ามีคนต้องการ "ทำได้แค่ X" ได้จริง X ต้องมีสิทธิ์ของตัวเอง. สิทธิ์ตัวเดียวที่คุมหลายหน้าจอ (`crm.sales.*` คุม 9 หน้า) คือสิ่งที่ไฟล์นี้มีไว้กัน.
- **ชื่อ module ย่อยเป็นเอกพจน์** — `crm.customer`, `crm.lead`, `pm.project`, `service.asset`.
- **key ของระบบภายนอก = `integration.` + ชื่อเดียวกัน** (`scope-rule.spec.ts`). scope ของเครื่องที่ไม่มีคนปลายทางและเห็นทั้งบริษัท ใช้ `.read.all` — เช่น `integration.crm.lead.read.all` (เดิมชื่อ `integration.crm.lead.read` จนถึง 3 พ.ย. 2569 ซึ่งตอนนี้เป็น twin ของ `crm.lead.read`). ตั้งชื่อแบบนี้แล้ว twin ของคนกับ scope ของเครื่องไม่มีทางชนกัน. ส่วนคนที่เครื่องทำงานแทน (`X-Acting-User`, MCP) ได้แค่แถวของตัวเองเสมอ (`readsAllLeads` ใน `libs/share/src/access/sales-rules.ts`).
- หน้าจอตั้งค่า Role แสดงสิทธิ์เป็นตาราง module ย่อย × (`read`, `read.all`, `manage`) และ verb เฉพาะทางเป็นชิปท้ายแถว — ตั้งชื่อนอกรูปแบบนี้ ช่องจะไปตกที่ชิป.

## 2. module ย่อยเป้าหมาย

| Module | module ย่อย |
|---|---|
| crm | `customer` · `lead` (Lead, บริษัทเป้าหมาย, งาน AI agent ของ Lead) · `deal` · `quotation` · `order` · `target` · `campaign` |
| service | `asset` · `workorder` · `billing` · `report` · `care` |
| pricing | `price` · `markup` · `exception` · `vendorcost` |

module อื่น (pm, delivery, legal, hr, presales, disbursement, kb, admin) แยกพอแล้ว หรือหน้าจอกรองตามตัวคนเอง.
ที่ยังไม่แยก (`crm.sales.*`, `service.asset.*` ที่คุมหลายหน้า, `pricing.price.*`) อยู่ต่อจนกว่าแผนจะทำถึง.

## 3. แยก module ย่อยออกจากสิทธิ์เดิม

ลำดับนี้ทำให้ไม่มีใครเสียสิทธิ์ระหว่างทาง:

1. เพิ่มใน catalog (`libs/share/src/policy/permissions.ts`) + twin `integration.*` + label ใน frontend `messages.ts`
2. เปลี่ยน route ของ module ย่อยนั้น (core `@Permissions` และ external acting ผ่าน `yarn crm:gen`). route ที่ใช้ร่วมกับ module อื่น (dashboard, รายงานรวม) ใช้ `@AnyPermission(เดิม, ใหม่)`
3. migration คัดลอก grant: `role_permissions` ที่ถือสิทธิ์เดิมได้สิทธิ์ใหม่ และ `api_keys.scopes` ที่ถือ twin เดิมได้ twin ใหม่ — แบบ `migrations/20261014120000_chat_widget_multi` และ `20261022110000_api_key_scopes_by_function`
4. `SEED_ROLES` ให้ตรงกับ migration — `seedRoles` เขียนสิทธิ์ของ system role ทับทุกครั้งที่ re-seed
5. frontend: เมนู, page gate, fetch ที่ viewer อ่านไม่ได้, ลิงก์ข้ามไปหน้าที่ viewer เปิดไม่ได้
6. apply migration ก่อน deploy โค้ด — กลับลำดับแล้วคนที่ถือแค่สิทธิ์เดิมจะเข้าหน้านั้นไม่ได้จนกว่า migration จะลง
7. ลบสิทธิ์เดิมได้เมื่อไม่มี route ไหนอ้างถึงแล้วเท่านั้น
