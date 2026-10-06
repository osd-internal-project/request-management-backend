# External API — ดัชนี endpoint ทั้งหมด

> **ไฟล์นี้สร้างโดย `yarn openapi` — อย่าแก้มือ** แก้ที่ controller แล้วรันใหม่
> ลำดับการเรียกตามสายงานอยู่ที่ [`EXTERNAL_API_GUIDE.md`](./EXTERNAL_API_GUIDE.md)

ทุก path นำหน้าด้วย `/api/v1` · **สิทธิ์กุญแจ** = ต้องอยู่ใน `scopes` ของ API key · **สิทธิ์คน** = คนใน `X-Acting-User` ต้องถือ (ว่าง = route ที่ไม่มีคน หรือ service ตรวจเอง)

## approval — เปิดเคสอนุมัติจากโมดูลอื่นที่ไม่มีคำขอในระบบรองรับ (APV-07)

| Method | Path | ทำอะไร | สิทธิ์กุญแจ | สิทธิ์คน |
|---|---|---|---|---|
| POST | `/approval/cases` | เปิดเคสอนุมัติจากโมดูลอื่น — ไม่ผูกกับคำขอในระบบ (APV-07) | integration.approval.create |  |

## assistant — คำถามของผู้ช่วยส่วนตัว — ดีลใกล้ปิด/เงียบ งานรออนุมัติ โครงการมีปัญหา งานบริการค้าง บทความ และตัวเลขสรุป

| Method | Path | ทำอะไร | สิทธิ์กุญแจ | สิทธิ์คน |
|---|---|---|---|---|
| GET | `/assistant/summary` | ตัวเลขสรุปของฉัน | integration.assistant.read | notification.read |
| GET | `/assistant/deals/closing` | ดีลที่ใกล้ปิด | integration.assistant.read | crm.sales.read |
| GET | `/assistant/deals/silent` | ดีลที่เงียบหรือเลยนัดติดตาม | integration.assistant.read | crm.sales.read |
| GET | `/assistant/approvals` | งานที่รอฉันอนุมัติ | integration.assistant.read | approval.decide |
| GET | `/assistant/projects/at-risk` | โครงการที่มีปัญหา | integration.assistant.read | notification.read |
| GET | `/assistant/service-jobs` | งานบริการที่ยังค้าง | integration.assistant.read | service.asset.read |
| GET | `/assistant/kb/articles` | ค้นบทความในคลังความรู้ | integration.assistant.read | notification.read |

## crm — ทะเบียนลูกค้า, Lead, โอกาสการขาย, ใบเสนอราคา, ใบสั่งขาย และหน้าตั้งค่า CRM

| Method | Path | ทำอะไร | สิทธิ์กุญแจ | สิทธิ์คน |
|---|---|---|---|---|
| GET | `/crm/customers` | ค้นทะเบียนลูกค้า | integration.crm.customer.read | crm.customer.read |
| POST | `/crm/customers` | สร้างทะเบียนลูกค้า | integration.crm.customer.manage | crm.customer.manage |
| GET | `/crm/customers/segment-options` | มิติและค่าการแบ่งกลุ่มที่ยังใช้งาน | integration.crm.customer.read | crm.customer.read |
| GET | `/crm/customers/kyc-products` | สินค้าที่บังคับทำ KYC | integration.crm.customer.read | crm.customer.read |
| POST | `/crm/customers/check-duplicate` | ตรวจลูกค้าซ้ำก่อนบันทึก | integration.crm.customer.read | crm.customer.read |
| POST | `/crm/customers/import` | นำเข้าลูกค้าเดิมจาก Excel | integration.crm.admin.manage | admin.crm.manage |
| GET | `/crm/customers/{id}` | รายละเอียดลูกค้า | integration.crm.customer.read | crm.customer.read |
| PATCH | `/crm/customers/{id}` | แก้ข้อมูลลูกค้า | integration.crm.customer.manage | crm.customer.manage |
| GET | `/crm/customers/{id}/invoices` | ใบแจ้งหนี้และการรับชำระของลูกค้าจาก SAP | integration.crm.customer.read | crm.customer.financial.read |
| GET | `/crm/customers/{id}/contacts/consents` | สถานะความยินยอมของผู้ติดต่อ | integration.crm.customer.read | crm.customer.read |
| GET | `/crm/customers/{id}/summary` | ตัวเลขสรุปหน้าลูกค้า 360° | integration.crm.customer.read | crm.customer.read |
| GET | `/crm/customers/{id}/contracts` | สัญญาของลูกค้า (ทะเบียนสัญญา) | integration.crm.customer.read | crm.customer.read |
| POST | `/crm/customers/{id}/contracts` | บันทึกสัญญาด้วยมือ | integration.crm.customer.manage | crm.customer.manage |
| PATCH | `/crm/customers/{id}/contracts/{contractId}` | แก้หรือยกเลิกสัญญา | integration.crm.customer.manage | crm.customer.manage |
| GET | `/crm/customers/{id}/kyc` | KYC ของลูกค้า (สถานะ ผลตรวจรายชื่อต้องห้าม ประวัติการยืนยัน) | integration.crm.customer.read | crm.customer.read |
| GET | `/crm/customers/{id}/requests` | คำขอทั้งหมดที่เกี่ยวกับลูกค้า (หน้า 360°) | integration.crm.customer.read | crm.customer.read |
| POST | `/crm/customers/{id}/activate` | เปิดใช้งานลูกค้า | integration.crm.customer.manage | crm.customer.manage |
| POST | `/crm/customers/{id}/suspend` | ระงับลูกค้าพร้อมเหตุผล | integration.crm.customer.manage | crm.customer.manage |
| POST | `/crm/customers/{id}/deactivate` | ปิดใช้งานลูกค้าพร้อมเหตุผล | integration.crm.customer.manage | crm.customer.manage |
| POST | `/crm/customers/{id}/locations` | เพิ่มที่อยู่หรือไซต์งาน | integration.crm.customer.manage | crm.customer.manage |
| PATCH | `/crm/customers/{id}/locations/{locationId}` | แก้ที่อยู่หรือไซต์งาน | integration.crm.customer.manage | crm.customer.manage |
| DELETE | `/crm/customers/{id}/locations/{locationId}` | ลบที่อยู่ออกจากทะเบียน | integration.crm.customer.manage | crm.customer.manage |
| POST | `/crm/customers/{id}/contacts` | เพิ่มผู้ติดต่อ | integration.crm.customer.manage | crm.customer.manage |
| PATCH | `/crm/customers/{id}/contacts/{contactId}` | แก้ผู้ติดต่อ | integration.crm.customer.manage | crm.customer.manage |
| DELETE | `/crm/customers/{id}/contacts/{contactId}` | ลบผู้ติดต่อ | integration.crm.customer.manage | crm.customer.manage |
| PUT | `/crm/customers/{id}/segments` | ตั้งกลุ่มของลูกค้าทั้งชุด | integration.crm.customer.manage | crm.customer.manage |
| GET | `/crm/customers/{id}/history` | ประวัติการแก้ไขรายฟิลด์ | integration.crm.customer.read | crm.customer.read |
| GET | `/crm/customers/{id}/timeline` | ไทม์ไลน์เหตุการณ์ของลูกค้า | integration.crm.customer.read | crm.customer.read |
| GET | `/crm/customers/{id}/external-codes` | รหัสลูกค้าในระบบภายนอก | integration.crm.admin.manage | admin.crm.manage |
| PUT | `/crm/customers/{id}/external-codes` | ตั้งหรือแก้รหัสในระบบภายนอก | integration.crm.admin.manage | admin.crm.manage |
| GET | `/crm/admin/lead-statuses` |  | integration.crm.admin.manage | admin.crm.manage |
| POST | `/crm/admin/lead-statuses` |  | integration.crm.admin.manage | admin.crm.manage |
| PATCH | `/crm/admin/lead-statuses/reorder` |  | integration.crm.admin.manage | admin.crm.manage |
| PATCH | `/crm/admin/lead-statuses/{id}` |  | integration.crm.admin.manage | admin.crm.manage |
| DELETE | `/crm/admin/lead-statuses/{id}` |  | integration.crm.admin.manage | admin.crm.manage |
| GET | `/crm/admin/kyc-products` |  | integration.crm.admin.manage | admin.crm.manage |
| POST | `/crm/admin/kyc-products` |  | integration.crm.admin.manage | admin.crm.manage |
| PATCH | `/crm/admin/kyc-products/{id}` |  | integration.crm.admin.manage | admin.crm.manage |
| GET | `/crm/admin/segment-dimensions` |  | integration.crm.admin.manage | admin.crm.manage |
| POST | `/crm/admin/segment-dimensions` |  | integration.crm.admin.manage | admin.crm.manage |
| PATCH | `/crm/admin/segment-dimensions/{id}` |  | integration.crm.admin.manage | admin.crm.manage |
| POST | `/crm/admin/segment-dimensions/{id}/values` |  | integration.crm.admin.manage | admin.crm.manage |
| PATCH | `/crm/admin/segment-values/{id}` |  | integration.crm.admin.manage | admin.crm.manage |
| DELETE | `/crm/admin/segment-values/{id}` |  | integration.crm.admin.manage | admin.crm.manage |
| GET | `/crm/admin/config` |  | integration.crm.admin.manage | admin.crm.manage |
| PATCH | `/crm/admin/config` |  | integration.crm.admin.manage | admin.crm.manage |
| GET | `/crm/admin/kyc-watchlist` |  | integration.crm.admin.manage | admin.crm.manage |
| POST | `/crm/admin/kyc-watchlist` |  | integration.crm.admin.manage | admin.crm.manage |
| PATCH | `/crm/admin/kyc-watchlist/{id}/deactivate` |  | integration.crm.admin.manage | admin.crm.manage |
| GET | `/crm/admin/trade-terms` |  | integration.crm.admin.manage | admin.crm.manage |
| PUT | `/crm/admin/trade-terms` |  | integration.crm.admin.manage | admin.crm.manage |
| GET | `/crm/admin/handover-items` |  | integration.crm.admin.manage | admin.crm.manage |
| PUT | `/crm/admin/handover-items` |  | integration.crm.admin.manage | admin.crm.manage |
| GET | `/crm/leads/statuses` | ขั้นของ Lead ทั้งชุด | integration.crm.sales.read | crm.sales.read |
| GET | `/crm/leads` | ค้นรายชื่อ Lead | integration.crm.sales.read | crm.sales.read |
| POST | `/crm/leads` | สร้าง Lead | integration.crm.sales.manage | crm.sales.manage |
| POST | `/crm/leads/import` | นำเข้า Lead จาก Excel | integration.crm.sales.manage | crm.sales.manage |
| GET | `/crm/leads/{id}` | รายละเอียด Lead พร้อมกิจกรรม | integration.crm.sales.read | crm.sales.read |
| PATCH | `/crm/leads/{id}` | แก้ข้อมูล Lead | integration.crm.sales.manage | crm.sales.manage |
| PATCH | `/crm/leads/{id}/owner` | รับ Lead หรือแจกให้คนอื่น | integration.crm.sales.manage | crm.sales.manage |
| PATCH | `/crm/leads/{id}/status` | เลื่อนขั้น Lead ในไปป์ไลน์ | integration.crm.sales.manage | crm.sales.manage |
| POST | `/crm/leads/{id}/activities` | ลงกิจกรรมของ Lead | integration.crm.sales.manage | crm.sales.manage |
| PATCH | `/crm/leads/{id}/activities/{activityId}` | แก้กิจกรรม หรือติ๊กเสร็จ | integration.crm.sales.manage | crm.sales.manage |
| POST | `/crm/leads/{id}/disqualify` | คัด Lead ออกพร้อมเหตุผล | integration.crm.sales.manage | crm.sales.manage |
| POST | `/crm/leads/{id}/convert` | แปลง Lead เป็นโอกาสการขาย | integration.crm.sales.manage | crm.sales.manage |
| GET | `/crm/opportunities` | ค้นโอกาสการขาย | integration.crm.sales.read | crm.sales.read |
| POST | `/crm/opportunities` | สร้างโอกาสการขาย | integration.crm.sales.manage | crm.sales.manage |
| GET | `/crm/opportunities/summary` | ยอดรวมต่อขั้นของโอกาสการขาย | integration.crm.sales.read | crm.sales.read |
| GET | `/crm/opportunities/dashboard` | แดชบอร์ด CRM | integration.crm.sales.read | crm.sales.read |
| GET | `/crm/opportunities/report` | รายงานยอดขาย | integration.crm.sales.read | crm.sales.read |
| GET | `/crm/opportunities/lost-reasons` | เหตุผลปิดแพ้ที่เลือกได้ | integration.crm.sales.read | crm.sales.read |
| GET | `/crm/opportunities/{id}` | รายละเอียดโอกาสการขาย | integration.crm.sales.read | crm.sales.read |
| PATCH | `/crm/opportunities/{id}` | แก้โอกาสการขาย | integration.crm.sales.manage | crm.sales.manage |
| GET | `/crm/opportunities/{id}/activities` | กิจกรรมและนัดติดตามของโอกาสการขาย | integration.crm.sales.read | crm.sales.read |
| POST | `/crm/opportunities/{id}/activities` | ลงกิจกรรมของโอกาสการขาย | integration.crm.sales.manage | crm.sales.manage |
| GET | `/crm/opportunities/{id}/negotiations` | รอบการต่อรองเงื่อนไขการค้าของโอกาสการขาย | integration.crm.sales.read | crm.sales.read |
| POST | `/crm/opportunities/{id}/negotiations` | บันทึกรอบการต่อรอง (นอกมาตรฐาน = ส่งฝ่ายกฎหมายอัตโนมัติ) | integration.crm.sales.manage | crm.sales.manage |
| GET | `/crm/opportunities/{id}/phone-numbers` | เลขหมายที่จองให้โอกาสการขาย (Reserve-phone) | integration.crm.sales.read | crm.sales.read |
| POST | `/crm/opportunities/{id}/phone-numbers` | จองเบอร์ให้โอกาสการขาย | integration.crm.sales.manage | crm.sales.manage |
| GET | `/crm/opportunities/{id}/phone-numbers/available` | ค้นเบอร์ว่างจาก Reserve-phone | integration.crm.sales.manage | crm.sales.manage |
| POST | `/crm/opportunities/{id}/phone-numbers/{reservationId}/extend` | ต่ออายุการจองเบอร์ (นับจากวันนี้) | integration.crm.sales.manage | crm.sales.manage |
| POST | `/crm/opportunities/{id}/phone-numbers/{reservationId}/release` | ปล่อยเบอร์ที่จองคืน Reserve-phone | integration.crm.sales.manage | crm.sales.manage |
| PATCH | `/crm/opportunities/{id}/activities/{activityId}` | แก้กิจกรรมของโอกาสการขาย หรือติ๊กเสร็จ | integration.crm.sales.manage | crm.sales.manage |
| POST | `/crm/opportunities/{id}/sale-orders` | เปิดใบสั่งขาย = ปิดชนะ + สร้างทะเบียนลูกค้า | integration.crm.sales.manage | crm.sales.manage |
| POST | `/crm/opportunities/{id}/quotations` | ร่างใบเสนอราคา v1 | integration.crm.sales.manage | crm.sales.manage |
| GET | `/crm/opportunities/{id}/margin` | CD-199 margin ของดีล — รวมใบเสนอราคาเวอร์ชันล่าสุดที่ยังมีผล (ต้นทุน/margin ถูกปกปิดตามสิทธิ์) | integration.crm.sales.read | crm.sales.read |
| POST | `/crm/opportunities/{id}/lose` | ปิดแพ้พร้อมเหตุผลมาตรฐาน | integration.crm.sales.manage | crm.sales.manage |
| GET | `/crm/sale-orders` | ค้นใบสั่งขาย | integration.crm.sales.read | crm.sales.read |
| GET | `/crm/sale-orders/{id}` | รายละเอียดใบสั่งขาย | integration.crm.sales.read | crm.sales.read |
| POST | `/crm/sale-orders/{id}/cancel` | ยกเลิกใบสั่งขายพร้อมเหตุผล | integration.crm.sales.manage | crm.sales.manage |
| GET | `/crm/sales-targets` | เป้าและพยากรณ์ของเดือน | integration.crm.sales.read | crm.sales.read |
| POST | `/crm/sales-targets` | ตั้งหรือปรับเป้า | integration.crm.sales.manage | crm.target.manage |
| GET | `/crm/sales-targets/{id}/revisions` | ประวัติการเปลี่ยนเป้า | integration.crm.sales.read | crm.sales.read |
| GET | `/crm/campaigns` | แคมเปญพร้อมผล | integration.crm.sales.read | crm.sales.read |
| POST | `/crm/campaigns` | สร้างแคมเปญ | integration.crm.sales.manage | crm.campaign.manage |
| PATCH | `/crm/campaigns/{id}` | แก้ไข / ปิดแคมเปญ | integration.crm.sales.manage | crm.campaign.manage |
| GET | `/crm/target-accounts` | บริษัทเป้าหมาย | integration.crm.sales.read | crm.sales.read |
| POST | `/crm/target-accounts` | เพิ่มบริษัทเป้าหมาย | integration.crm.sales.manage | crm.sales.manage |
| PATCH | `/crm/target-accounts/{id}` | แก้ไขบริษัทเป้าหมาย / ลำดับ / ผู้รับผิดชอบ | integration.crm.sales.manage | crm.sales.manage |
| POST | `/crm/target-accounts/{id}/approach` | เริ่มเข้าหา — สร้าง Lead จากบริษัทเป้าหมาย | integration.crm.sales.manage | crm.sales.manage |
| POST | `/crm/target-accounts/{id}/drop` | ตัดบริษัทเป้าหมายออกพร้อมเหตุผล | integration.crm.sales.manage | crm.sales.manage |
| POST | `/crm/target-accounts/{id}/reopen` | นำบริษัทที่ตัดออกกลับมาเล็งใหม่ | integration.crm.sales.manage | crm.sales.manage |
| GET | `/crm/quotations` | ค้นใบเสนอราคา | integration.crm.sales.read | crm.sales.read |
| GET | `/crm/quotations/{id}` | รายละเอียดใบเสนอราคา | integration.crm.sales.read | crm.sales.read |
| PATCH | `/crm/quotations/{id}` | แก้ใบเสนอราคา | integration.crm.sales.manage | crm.sales.manage |
| GET | `/crm/quotations/{id}/print` | ใบเสนอราคาฉบับพิมพ์ส่งลูกค้า | integration.crm.sales.read | crm.sales.read |
| POST | `/crm/quotations/{id}/submit` | ยื่นใบเสนอราคาขออนุมัติราคา | integration.crm.sales.manage | crm.sales.manage |
| POST | `/crm/quotations/{id}/send` | ส่งใบเสนอราคาให้ลูกค้า | integration.crm.sales.manage | crm.sales.manage |
| POST | `/crm/quotations/{id}/accept` | บันทึกว่าลูกค้าตอบรับ | integration.crm.sales.manage | crm.sales.manage |
| POST | `/crm/quotations/{id}/decline` | บันทึกว่าลูกค้าปฏิเสธ | integration.crm.sales.manage | crm.sales.manage |
| POST | `/crm/quotations/{id}/revise` | ออกใบเสนอราคาเวอร์ชันใหม่ | integration.crm.sales.manage | crm.sales.manage |
| POST | `/crm/quotations/{id}/cancel` | ยกเลิกใบเสนอราคาพร้อมเหตุผล | integration.crm.sales.manage | crm.sales.manage |
| POST | `/crm/leads/intake` | รับ Lead จากระบบภายนอก — เข้ากองกลาง รอพนักงานขายรับ | integration.crm.lead.create |  |
| GET | `/crm/leads/forms/{token}` | CD-269 หัวฟอร์มสาธารณะของแคมเปญ (ชื่อแคมเปญ + ข้อความแนะนำ) | integration.crm.lead.create |  |
| POST | `/crm/leads/forms/{token}` | CD-269 ส่งฟอร์มสาธารณะของแคมเปญ — คัดกรองเหมือน intake | integration.crm.lead.create |  |
| POST | `/crm/leads/ads/{platform}` | CD-269 Lead Ads (facebook \| tiktok) — ตัวแปลงข้อมูลฟอร์มโฆษณา | integration.crm.lead.create |  |
| GET | `/crm/leads/{id}/facts` | ข้อเท็จจริงของ Lead สำหรับ Decision node — สถานะ + จำนวนกิจกรรม | integration.crm.lead.read |  |
| POST | `/crm/leads/{id}/stage` | บันทึกขั้นที่ workflow ตัดสินใจแล้ว — core ไม่ตัดสินว่าเลื่อนได้ไหม | integration.crm.lead.stage |  |

## delivery — การส่งมอบของโครงการ — แผนส่งมอบ งวดวางบิล และการส่งต่อทีมบริการ

| Method | Path | ทำอะไร | สิทธิ์กุญแจ | สิทธิ์คน |
|---|---|---|---|---|
| GET | `/delivery/projects/{projectId}` | แผนส่งมอบของโครงการ (CD-250) | integration.delivery.read | notification.read |
| GET | `/delivery/projects/{projectId}/billing` | งวดของสัญญา: สถานะวางบิล/SAP และสิ่งที่ยังขวาง (CD-253) | integration.delivery.read | notification.read |
| GET | `/delivery/projects/{projectId}/handovers` | รอบตรวจรับที่ส่งต่อให้ทีมบริการ และสถานะการรับทราบ (CD-255) | integration.delivery.read | notification.read |

## flow — ติดตามดีลหนึ่งใบทั้งสาย — ดีล → Pre-Sales → ใบเสนอราคา → ใบสั่งขาย → สัญญา → โครงการ

| Method | Path | ทำอะไร | สิทธิ์กุญแจ | สิทธิ์คน |
|---|---|---|---|---|
| GET | `/flow/opportunities/{id}` | ติดตามดีลทั้งสาย — ดีล → Pre-Sales → ใบเสนอราคา → ใบสั่งขาย → สัญญา → โครงการ | integration.flow.read | crm.sales.read |

## kb

| Method | Path | ทำอะไร | สิทธิ์กุญแจ | สิทธิ์คน |
|---|---|---|---|---|
| POST | `/kb/ai/search` | ค้นบทความที่เผยแพร่ให้ลูกค้าเพื่อใช้ตอบ (CD-265) | integration.kb.read |  |
| POST | `/kb/ai/queries/{queryId}/answer` | บันทึกคำตอบและบทความที่อ้างอิง หรือว่าตอบไม่ได้ (CD-265) | integration.kb.read |  |

## legal — คลังสัญญา — อ่านอย่างเดียว

| Method | Path | ทำอะไร | สิทธิ์กุญแจ | สิทธิ์คน |
|---|---|---|---|---|
| GET | `/legal/contracts` | ค้นคลังสัญญา | integration.legal.read | legal.contract.read |
| GET | `/legal/contracts/{id}` | รายละเอียดสัญญา | integration.legal.read | legal.contract.read |
| GET | `/legal/contracts/{id}/terms` | ข้อกำหนดของสัญญา — ความรับผิด ค่าปรับ การรับประกัน ระดับบริการ | integration.legal.read | legal.contract.read |
| GET | `/legal/contracts/{id}/installments` | แผนการวางบิลตามงวด (CD-164) | integration.legal.read | legal.contract.read |
| GET | `/legal/contracts/{id}/obligations` | ข้อผูกพันของสัญญา (CD-163) | integration.legal.read | legal.contract.read |

## mcp — ช่องทาง JSON-RPC สำหรับ tool-caller (LibreChat, MCP client)

| Method | Path | ทำอะไร | สิทธิ์กุญแจ | สิทธิ์คน |
|---|---|---|---|---|
| POST | `/mcp` | MCP (JSON-RPC) — initialize · tools/list · tools/call |  |  |

## pm — โครงการ — ค้น อ่าน และเปิดโครงการจากสัญญาที่ลงนามแล้ว

| Method | Path | ทำอะไร | สิทธิ์กุญแจ | สิทธิ์คน |
|---|---|---|---|---|
| GET | `/pm/projects` | ค้นโครงการ | integration.pm.read | notification.read |
| POST | `/pm/projects` | เปิดโครงการจากสัญญาที่ลงนามแล้ว (CD-175) | integration.pm.manage | pm.project.manage |
| GET | `/pm/projects/openable-contracts` | สัญญาที่ลงนามแล้วและยังไม่ได้เปิดโครงการ | integration.pm.manage | pm.project.manage |
| GET | `/pm/projects/preview/{contractId}` | ตรวจก่อนเปิดโครงการ — ข้อมูลที่จะดึงมา และสิ่งที่ยังขาด | integration.pm.manage | pm.project.manage |
| GET | `/pm/projects/by-contract/{contractId}` | โครงการที่เปิดจากสัญญานี้ | integration.pm.read | notification.read |
| GET | `/pm/projects/{id}` | รายละเอียดโครงการ | integration.pm.read | notification.read |
| GET | `/pm/projects/{id}/milestones` | หมุดหมายของโครงการ และงวดชำระของสัญญา (CD-182) | integration.pm.read | notification.read |

## presales — Solution ของดีล — อ่านอย่างเดียว

| Method | Path | ทำอะไร | สิทธิ์กุญแจ | สิทธิ์คน |
|---|---|---|---|---|
| GET | `/presales/opportunities/{id}/solutions` | Solution ทั้งหมดของดีล | integration.presales.read | crm.sales.read |
| GET | `/presales/solutions/{id}` | Solution พร้อมเวอร์ชันล่าสุด | integration.presales.read | notification.read |
| GET | `/presales/solutions/{id}/versions/{no}` | Solution ที่เวอร์ชันที่ระบุ | integration.presales.read | notification.read |
| GET | `/presales/solutions/{id}/versions/{no}/proposal` | ข้อเสนอทางเทคนิค (CD-137) | integration.presales.read | notification.read |
| GET | `/presales/solutions/{id}/quotations` | ใบเสนอราคาที่สร้างจาก Solution นี้ (CD-198) | integration.presales.read | notification.read |

## request — คำขอ (Platform Request) ตั้งแต่เปิดจนปิด สำหรับระบบภายนอก เช่น chatbot

| Method | Path | ทำอะไร | สิทธิ์กุญแจ | สิทธิ์คน |
|---|---|---|---|---|
| GET | `/request/request-types` | ประเภทคำขอที่ผู้ใช้รายนี้เปิดได้ ณ ตอนนี้ | integration.request.create | request.create |
| GET | `/request/request-types/{code}/form` | ฟอร์ม ตัวเลือก ผู้รับที่เลือกได้ และกติกาของประเภทคำขอนี้ | integration.request.create | request.create |
| GET | `/request/requests` | คิวงานของผู้ใช้รายนี้ แบ่งตามมุมมองที่เลือก | integration.request.create | request.read |
| POST | `/request/requests` | สร้างคำขอและยื่นในครั้งเดียว | integration.request.create | request.create |
| GET | `/request/requests/summary` | จำนวนคำขอแยกตามสถานะ — ตอบคำถาม "งานค้างกี่ใบ" ในครั้งเดียว | integration.request.create | request.read |
| GET | `/request/users` | ค้นหาคนในบริษัท — แปลงชื่อหรืออีเมลเป็น id ที่ API รับ | integration.request.create | request.create |
| GET | `/request/requests/{ref}` | อ่านคำขอหนึ่งใบ ด้วยเลขที่เอกสารหรือ uuid | integration.request.create | request.read |
| GET | `/request/requests/{ref}/actions` | ตอนนี้ผู้ใช้รายนี้ทำอะไรกับคำขอใบนี้ได้บ้าง | integration.request.create | request.read |
| POST | `/request/requests/{ref}/actions/{action}` | สั่งทำหนึ่ง action กับคำขอใบนี้ | integration.request.create |  |
| GET | `/request/requests/{ref}/tree` | ใบนี้ ใบพ่อ และทุกใบลูกที่แตกออกไป | integration.request.create | request.read |
| POST | `/request/intake` | ระบบภายนอกยื่นคำขอในนามตัวเอง — ไม่มีคนเป็นผู้ยื่น (REQ-10) | integration.request.create |  |
| GET | `/request/intake/web-forms/{slug}` | แบบฟอร์มสาธารณะ: ข้อความและประเภทคำขอที่เปิดรับ (CD-66) | integration.request.intake |  |
| POST | `/request/intake/web-forms/{slug}` | ลูกค้ายื่นคำขอผ่านแบบฟอร์มสาธารณะ (CD-66) | integration.request.intake |  |
| POST | `/request/intake/channels/{channel}` | ช่องทางอื่น (เช่น AI CARE) ยื่นคำขอแทนลูกค้า (CD-66) | integration.request.intake |  |
| GET | `/request/intake/status/{token}` | สถานะคำขอตามลิงก์ติดตามของลูกค้า (CD-66) | integration.request.intake |  |

## support — งานบริการหลังการขาย — ทะเบียนอุปกรณ์ สิทธิ์บริการ และเปิดใบสั่งงานบริการ

| Method | Path | ทำอะไร | สิทธิ์กุญแจ | สิทธิ์คน |
|---|---|---|---|---|
| GET | `/support/assets` | ค้นทะเบียนอุปกรณ์ที่ติดตั้ง | integration.support.read | service.asset.read |
| GET | `/support/assets/{id}` | รายละเอียดและประวัติของอุปกรณ์ | integration.support.read | service.asset.read |
| GET | `/support/entitlements` | สิทธิ์บริการ (ประกัน / สัญญาบริการ MA) | integration.support.read | service.asset.read |
| GET | `/support/entitlements/{id}` | รายละเอียดสิทธิ์ และอุปกรณ์ที่ครอบคลุม | integration.support.read | service.asset.read |
| GET | `/support/work-orders` | ใบสั่งงานบริการ — ที่ยังเปิด หรือทั้งหมด | integration.support.read | service.asset.read |
| POST | `/support/work-orders` | เปิดใบสั่งงานบริการ (CD-239) | integration.support.manage | service.asset.manage |
| GET | `/support/work-orders/by-request/{requestId}` | ข้อมูลบริการของคำขอ | integration.support.read | notification.read |
| GET | `/support/work-orders/{id}` | รายละเอียด + สิทธิ์ที่ครอบคลุมอุปกรณ์วันนี้ | integration.support.read | service.asset.read |
