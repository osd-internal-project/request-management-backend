# ชุดรายการของ product

12 พ.ย. 2569 — user decision. เมื่อลูกค้าสนใจ product หนึ่ง ใบเสนอราคามักมีหลาย item
(license, ค่าติดตั้ง, อุปกรณ์ …) หน้านี้เก็บว่า **product ไหนต้องดึง item อะไร** เพื่อให้
งานขายอัตโนมัติ (`docs/sales-email-flow.md`) และพนักงานขายไม่ต้องจำเอง

## ข้อมูล

| ตาราง | เก็บอะไร |
|---|---|
| `product_bundles` | หนึ่งแถวต่อ product ต่อบริษัท: `name`, `note`, `active`, soft delete |
| `product_bundle_items` | item ของชุด: `productCode` (SAP ItemCode), `quantity`, `termMonths?`, `optional`, `fixedQuantity` |

13 พ.ย. 2569 (migration `20261113110000_bundle_requirements`):

- `product_bundles.requirements` — `[{key, question, hints[]}]` สิ่งที่ต้องรู้จากลูกค้าก่อนออกใบเสนอราคา
  งานขายอัตโนมัติถามข้อที่ยังไม่มีคำตอบทางอีเมล (`sales-email-flow.md` หัวข้อ requirement); ไม่เกิน 15 ข้อ,
  `key` ว่าง = ระบบตั้ง `q1…`, `quantity` สงวนไว้ (ระบบถามจำนวนเองเสมอ)
- `fixedQuantity` — จำนวนในชุดคือของ **1 หน่วย**: จำนวนที่ลูกค้าขอ (`intake_data.requirements.quantity`)
  คูณทุก item ยกเว้นที่ตั้ง `fixedQuantity = true` (เช่น ค่าติดตั้งครั้งเดียว). Lead ที่ลูกค้ายังไม่บอกจำนวน = คูณ 1
  (เท่าพฤติกรรมเดิม); Lead ที่มีรายการของตัวเอง (`intake_data.products`) ไม่ถูกคูณ

- `name` คือชื่อ product ตามที่พนักงานขายเลือกบน Lead — เทียบแบบไม่สนตัวพิมพ์/ช่องว่าง
  (`bundleKey`) และไม่ซ้ำในบริษัทเดียวกัน (409)
- `optional = false` item หลัก เข้าใบเสนอราคาเสมอ; `true` item เสริม พนักงานขายเลือกเพิ่มบน Lead
- ชุดต้องมี item หลักอย่างน้อย 1; รหัสต้องอยู่ในรายการสินค้าจาก SAP (`products`)
- กติกาอยู่ใน `crm/product-bundle-rules.ts` (pure, มีเทสต์)

## Lead ได้รายการจากไหน

`ProductBundlesService.itemsForLead` — ที่เดียวที่ตัดสิน ใช้ทั้งตอนออกใบเสนอราคาอัตโนมัติ
(`SalesMailService.standardQuotation`) และ checklist บนการ์ด "งานขายอัตโนมัติ":

1. `intake_data.products` ของ Lead — รายการที่ Vuvagent เขียน หรือที่พนักงานขายปรับบนการ์ด
   "รายการในใบเสนอราคา" (`[{product_code, quantity, term_months?}]`)
2. ไม่มี → item **หลัก** ของชุดรายการที่ชื่อตรงกับ product ของ Lead
   (`intake_data.selected_product` จากการ์ด Proposal, ไม่มีจึงใช้ `subProduct`)
3. ไม่มีชุด → `subProduct` อ่านเป็นรหัสสินค้า × 1 (พฤติกรรมเดิม)
4. ไม่มีเลย → 422 `CRM_QUOTATION_UNPRICED` (`items` / `no_products`)

item ที่ไม่มีราคามาตรฐานยังทำให้ทั้งใบหยุดเหมือนเดิม (ข้อตัดสิน 5 พ.ย. 2569)

## Route (core-service, หน้าจอเท่านั้น)

| Route | สิทธิ์ |
|---|---|
| `GET pricing/product-bundles` | `pricing.price.read` หรือ `pricing.price.manage` |
| `GET pricing/product-bundles/match?name=` | `crm.lead.read` / `crm.sales.read` / `pricing.price.*` อย่างใดอย่างหนึ่ง — ชุดที่เปิดใช้ของชื่อนั้น หรือ `null` |
| `POST` · `PATCH :id` · `DELETE :id` | `pricing.price.manage` — `PATCH` ที่ส่ง `items` = แทนทั้งรายการ |

ทุก item ในคำตอบมีชื่อสินค้าและราคามาตรฐาน (THB) ที่มีผลวันนี้ — `unitPrice: null`
คือไม่มีราคา. ไม่มี route บน external-service: เครื่องอ่านผลผ่านใบเสนอราคาที่ได้

## หน้าจอ

- `/pages/pricing/bundles` — เมนู "ชุดรายการของ Product" ในกลุ่ม Pricing
- หน้า Lead — การ์ด "รายการในใบเสนอราคา": แสดงรายการตามชุด, "ปรับรายการ" เขียน
  `intake_data.products`, "ใช้ตามชุด" ลบ key นั้น (`PATCH leads/:id/intake-data` เดิม)
