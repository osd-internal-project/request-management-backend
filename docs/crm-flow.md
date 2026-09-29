# CRM — วงจรการทำงานที่มีอยู่จริงในระบบ

เอกสารนี้อธิบายว่า **CRM วันนี้ทำอะไรได้จริง** ไล่จากโค้ดที่รันอยู่ ไม่ใช่จากสเปก
ทุกหัวข้ออ้าง `path:line` ให้ไปอ่านของจริงต่อได้

**ตรวจครั้งล่าสุด 21 ก.ย. 2569** — `npx jest --testPathPatterns=crm` ใน
`services/core-service` ได้ **21 suites / 183 tests ผ่านทั้งหมด** และ
`docs/openapi/external-crm.json` เป็น **62 path / 79 operation** โดย **63 ตัวมี
`summary` แล้ว** ที่เหลือ 16 เป็นกลุ่ม admin

> **CRM ไม่ใช่โครงเปล่า** `grep -rn "NotImplementedException\|notImplemented(" services/*/src libs/`
> ไม่เจออะไรเลย (ต้องจำกัดที่ `src` — ไม่งั้นติด `dist/` ที่เป็นผลของ build) ตัวช่วย `services/core-service/src/common/not-implemented.ts` ถูก
> ประกาศไว้แต่ไม่มีใคร import ทุก route ต่อกับ service จริง เขียน Prisma จริง มี audit
> และ timeline จริง (ก่อน 17 ก.ย. `AGENTS.md` เขียนว่า handler โยน `501` — นั่นเป็น
> ข้อมูลค้างจาก S3 ตอนเริ่มโครง และถูกแก้แล้ว)

---

## 1. วงจรหลัก

```
Lead  ── เข้ากองกลาง ไม่มีเจ้าของ (ownerUserId = null)
  │
  ├─ assign        รับเองหรือหัวหน้าแจก        leads.service.ts:301
  ├─ setStatus     เลื่อนขั้นในไปป์ไลน์          leads.service.ts:368
  ├─ addActivity   บันทึกกิจกรรม / นัดหมาย       leads.service.ts:418
  ├─ disqualify    คัดออก → status kind lost    leads.service.ts:479
  └─ convert       → Opportunity               leads.service.ts:513
        │
        Opportunity  stage: qualifying → proposing → negotiating
          │          (customerId ว่างได้ ใช้ prospect snapshot แทน)
          │
          ├─ addActivity           กิจกรรม / นัดติดตาม   opportunity-activities.service.ts:77
          │                        ไม่มี due_at = ทำแล้ว · มี due_at = นัดไว้
          │                        refreshSummary เขียน lastActivityAt ·
          │                        nextFollowUpAt · ล้าง staleAlertedAt
          ├─ updateActivity        ติ๊กเสร็จ / เปิดกลับ  opportunity-activities.service.ts:145
          │
          ├─ lose                  → stage lost        opportunities.service.ts:352
          │
          ├─ createForOpportunity  → Quotation v1 draft  quotations.service.ts:206
          │     │
          │     ├─ submit   margin ผ่าน → approved ทันที      quotations.service.ts:354
          │     │           margin ต่ำ  → เปิด request DSC
          │     │                         แล้วรอ → pending_approval
          │     ├─ send     approved → sent               quotations.service.ts:477
          │     ├─ accept   sent → accepted               quotations.service.ts:499
          │     ├─ decline  sent → declined               quotations.service.ts:526
          │     ├─ revise   → superseded + v(n+1) draft   quotations.service.ts:584
          │     └─ printView ฉบับพิมพ์ + หัวกระดาษ (CD-76)  quotation-print.service.ts:81
          │                 ไม่ดึงต้นทุน/margin จึงอ่านได้ด้วย crm.sales.read
          │
          └─ open Sale Order   ◀── จุดที่ทะเบียนลูกค้าถูกสร้าง
                               และโอกาสการขายถูกปิดชนะ    sale-orders.service.ts:108

  (ไม่มีคนกด)  sweep รายชั่วโมงของ core-service           opportunity-stale-monitor.service.ts:82
               โอกาสที่เปิดอยู่และเงียบเกิน staleOpportunityDays
               → ประทับ staleAlertedAt แล้วแจ้งเจ้าของ + หัวหน้า (CD-65)
               external-service ตั้ง interval เป็น 0 — นาฬิกาเป็นของ core เท่านั้น
```

**สามอย่างที่ผิดความคาดหมายมากที่สุด และไม่มีบันทึกไว้ที่อื่น** — อ่านสามข้อนี้ก่อน
วางแผนอะไรกับ CRM

### 1.1 ทะเบียนลูกค้าเกิดตอนเปิดใบสั่งขาย ไม่ใช่ตอนต้นทาง

Lead และ Opportunity ทำงานได้โดย **ไม่ต้องมีลูกค้าในทะเบียน** — `Opportunity` เก็บ
`prospectName` / `prospectTaxId` / `prospectContactName` / `prospectPhone` /
`prospectEmail` ไว้แทน (DB CHECK บังคับว่าต้องมี `customerId` หรือ `prospectName`
อย่างใดอย่างหนึ่ง)

`SaleOrdersService.open` (`sale-orders.service.ts:108`) คือจุดที่ตัดสิน ลำดับการหา
ลูกค้าอยู่ใน `resolveCustomer` (`:433`): ลูกค้าที่โอกาสผูกอยู่ → `customer_id` ที่ผู้เรียก
ส่งมา → รายเดิมที่ **เลขภาษี + รหัสสาขา** ตรง (จงใจ เพื่อไม่ให้ไปสะดุดกฎกันซ้ำ CM-03)
→ **สร้างใหม่จาก prospect**

ลำดับนี้จงใจและห้ามสลับ — doc comment ที่ `:100-107` ระบุว่าใบเสนอราคาถูกตรวจ
**ก่อน** หาลูกค้า เพราะใบเสนอราคาผิดต้องไม่ทิ้งลูกค้าที่เพิ่งสร้างค้างไว้

### 1.2 ไม่มี `win()` บนโอกาสการขาย

ปิดชนะเกิดจากการเปิดใบสั่งขายเท่านั้น ใน transaction เดียวกับที่สร้าง `SaleOrder`
โอกาสถูกเซ็ต `stage: 'won'` + `wonAt` + `customerId` และล้าง lost reason ทิ้ง

มี spec ยืนยันไว้ตรง ๆ — `sale-orders.service.spec.ts:170`
*"ไม่มี win() แล้ว — ปิดชนะเกิดจากการเปิดใบสั่งขายเท่านั้น"*

### 1.3 Lead ไม่มี state machine ในระบบนี้

ต่างจาก `Customer` ที่มีตาราง transition จริง (`customer-state-machine.ts:33-36`)
**Lead ไม่มีไฟล์แบบนั้นเลย** และนั่นเป็นมติ PO เมื่อ 10 ก.ย. 2569 —
*"Workflow owns Process, Core owns Data"* กฎขั้นตอนอยู่ที่ workflow `lwf-0001`
บน service `workflowable` ไม่ได้อยู่ในรีโปนี้

core ตรวจแค่ความถูกต้องของข้อมูล สองที่:

| ที่ | ตรวจอะไร |
|---|---|
| `leads.service.ts:368` `setStatus` | code มีจริงในบริษัท · เป็น `kind: open` · ยัง `active` — ปลายทางที่เป็น won/lost ถูกปฏิเสธ ให้ใช้ปุ่มแปลง/คัดออกแทน |
| `lead-workflow.service.ts:85` `applyStage` | สามข้อข้างบน + lead ต้องยังเปิดอยู่ + **idempotent** (ขั้นเดิม = `{changed:false}` ไม่เขียน audit) |

**`applyStage` ยอมให้เลื่อนถอยหลังหรือข้ามขั้น** — spec เขียนไว้ชัดว่า
*"core ไม่ตัดสินกฎ — เลื่อนถอยหลังหรือข้ามขั้นก็ยอม"* สถานะปลายทาง (won/lost)
เข้าถึงได้ทางเดียวคือผ่าน `convert` และ `disqualify` ซึ่งเขียนคอลัมน์ประกอบใน
transaction เดียวกัน

---

## 2. จุดเชื่อมกับโมดูล Request

**ที่เดียวที่ CRM เปิด request จริง** คือใบเสนอราคาที่ margin ต่ำกว่าเกณฑ์

```
Quotation.submit (quotations.service.ts:354)
  │
  ├─ margin ≥ minMarginPct  → approved ทันที  audit crm.quotation.approved {by:'margin_check'}
  │
  └─ margin < minMarginPct  → ต้องมี reason
        └─ RequestsService.create({ type_code: DSC, ref_type:'quotation', ref_id })
              → Quotation.status = pending_approval + approvalRequestId
```

- ประเภทคำขอที่ใช้มาจาก `CrmCompanyConfig.quotationApprovalTypeCode` — **ค่าตั้งต้น
  คือ `DSC` (ขอส่วนลด) และแก้ได้จากหน้า admin** ไม่ได้ hard-code
- ถ้าประเภทนั้นไม่ได้เปิดใช้ในบริษัท → `CRM_QUOTATION_APPROVAL_UNAVAILABLE` และ
  **ใบเสนอราคาคงอยู่ที่ `draft`** ไม่ค้างครึ่งทาง
- `minMarginPct` ถูก **ประทับลงบนใบเสนอราคา** ตอน submit การแก้ config ทีหลังจึงไม่
  ย้อนไปตัดสินใบที่ตัดสินไปแล้ว — หลักการเดียวกับ `typeSnapshot` ของ request

ขากลับเป็น event ไม่ใช่ polling — `QuotationApprovalSyncService` ฟัง
`requestApproved` / `requestRejected` / `requestCancelled` แล้วหาใบเสนอราคาจาก
`approvalRequestId` ที่ยัง `pending_approval` อยู่:

| request | ใบเสนอราคา |
|---|---|
| approved | `approved` + `approvedAt` |
| rejected · cancelled | **กลับเป็น `draft`** ไม่ใช่ rejected |

---

## 3. สถานะและ enum

ค่าทั้งหมดดึงจาก `libs/prisma/schema.prisma` ตรง ๆ

| enum | ค่า |
|---|---|
| `CustomerType` | `corporate` · `individual` · `government` |
| `CustomerStatus` | `draft` · `active` · `suspended` · `inactive` |
| `CustomerContactRole` | `decision_maker` · `user` · `procurement` · `finance` · `other` |
| `LeadStatusKind` | `open` · `won` · `lost` |
| `LeadActivityType` | `call` · `email` · `meeting` · `task` · `note` — **ใช้ร่วมกับ `opportunity_activities` ด้วย** ไม่ได้เป็นของ Lead อย่างเดียวตั้งแต่ CD-65 |
| `OpportunityStage` | `qualifying` · `proposing` · `negotiating` · `won` · `lost` |
| `QuotationStatus` | `draft` · `pending_approval` · `approved` · `sent` · `accepted` · `declined` · `superseded` · `cancelled` |
| `SaleOrderStatus` | `open` · `cancelled` |
| `IntegrationJobStatus` | `pending` · `succeeded` · `failed` |

**`Lead.status` ไม่ใช่ enum** — เป็น `String` ที่อ้าง `lead_statuses.code` ซึ่งตั้งค่าได้
ต่อบริษัท มีแต่ *kind* ที่เป็น enum นี่คือเหตุผลที่เพิ่มขั้นในไปป์ไลน์ได้โดยไม่ต้อง migrate

### ตาราง transition ที่มีจริง

**Customer** (`customer-state-machine.ts:33-36`) — ตัวเดียวที่เป็นตารางเต็มรูปแบบ
ผิดเมื่อไรได้ `CRM_CUSTOMER_STATE_INVALID` (409)

```
draft     → active | inactive
active    → suspended | inactive
suspended → active | inactive
inactive  → active
```

`draft` กลับเข้าไปใหม่ไม่ได้ และมี spec คุมความครบถ้วนไว้ว่า **ค่า `CustomerStatus`
ใหม่ต้องถูกเพิ่มในตารางนี้** ไม่งั้น test แตก

**Quotation** (`quotations.service.ts:53-65`) — เป็นค่าคงที่สองชุด ไม่ใช่ตาราง

```
REVISABLE   = pending_approval · approved · sent · declined
CANCELLABLE = draft · pending_approval · approved · sent
```

**Opportunity** ไม่มีตาราง — `requireOpen()` กันแก้ไขเมื่อ won/lost และ `lose()`
บังคับว่า `reason_code` ต้องมีใน `OpportunityLostReason` ของบริษัทและยัง active

### สามคอลัมน์ที่ CD-65 เพิ่มบน Opportunity — ไม่ใช่สถานะ แต่ตัดสินว่าดีลไหน "เงียบ"

| คอลัมน์ | ใครเขียน | ความหมาย |
|---|---|---|
| `lastActivityAt` | `refreshSummary` เท่านั้น | กิจกรรมที่ **ทำเสร็จ** ล่าสุด · NULL = ยังไม่เคยมี นับความเงียบจาก `createdAt` |
| `nextFollowUpAt` | `refreshSummary` เท่านั้น | กำหนดที่ใกล้ที่สุดของกิจกรรมที่ **ยังไม่เสร็จ** · NULL = ไม่มีนัดค้าง |
| `staleAlertedAt` | sweep เขียน · `refreshSummary` ล้าง | ครั้งล่าสุดที่แจ้งหัวหน้า ล้างเมื่อมีงานเสร็จใหม่กว่า ดีลที่เงียบซ้ำจึงถูกจับได้อีก |

**ห้ามเขียนสามคอลัมน์นี้จากที่อื่น** — class doc ของ `opportunity-activities.service.ts`
เขียนไว้ตรง ๆ ว่า "จึงต้องไม่มีทางเขียนกิจกรรมโดยไม่ผ่านที่นี่" การเขียนตรงจะทำให้
รายการติดตามกับความจริงแยกจากกันเงียบ ๆ

กรองได้จาก `GET /opportunities?follow_up=overdue|stale` (`dto/sales.dto.ts`)

---

## 4. API ที่เปิดให้ระบบภายนอก

`docs/openapi/external-crm.json` — **62 path / 79 operation** ทั้งหมดอยู่ใต้
`/api/v1/crm/*` บน external-service

| กลุ่ม | ops | สิทธิ์ที่ใช้ |
|---|---|---|
| customers | 24 | `crm.customer.read` / `crm.customer.manage` · `import` ใช้ `admin.crm.manage` |
| admin (ตั้งค่า CRM) | 16 | `admin.crm.manage` ทั้งหมด |
| leads | 15 | `crm.sales.read` / `crm.sales.manage` · สามตัวเป็น robot-only |
| quotations | 10 | `crm.sales.read` / `crm.sales.manage` · `print` อ่านได้ด้วย `crm.sales.read` เพราะไม่ดึงต้นทุน |
| opportunities | 11 | `crm.sales.read` / `crm.sales.manage` · รวมกิจกรรมและการติดตาม (CD-65) |
| sale-orders | 3 | `crm.sales.read` / `crm.sales.manage` |

### สองประตูเหมือน request ทุกประการ

76 จาก 79 operation ประกาศครบทั้งคู่ — `@Permissions('integration.crm.*')` สำหรับ
เครื่อง และ `@ActingPermissions('crm.*')` สำหรับคน พร้อม `@ServiceAccountOnly()` และ
`@UseGuards(ActingUserGuard, ActingPolicyGuard)`

**`crm-route-parity.spec.ts` fail ถ้าสองฝั่งไม่ตรงกัน** — มันอ่านซอร์สทั้งสองไดเรกทอรี
แล้วเทียบห้าอย่าง: controller ครบไหม · route ตรงกันตัวต่อตัว · `@ActingPermissions`
เท่ากับ `@Permissions` ของ route หน้าจอเป๊ะ ๆ · แต่ละสิทธิ์คนมีสิทธิ์เครื่องคู่กัน ·
ทุก controller ที่ generate มามี guard ครบ

⇒ **เพิ่ม route CRM ต้องเพิ่มที่ core ก่อน แล้วรัน `yarn crm:gen`** controller ฝั่ง
external สี่ตัวถูก generate จาก `scripts/generate-crm-controllers.py` และมีหัวไฟล์เขียน
ว่าห้ามแก้มือ

### สามตัวที่ไม่มีคนอยู่ปลายสาย

| route | สิทธิ์เครื่อง | ทำไมไม่มี `X-Acting-User` |
|---|---|---|
| `POST /crm/leads/intake` | `integration.crm.lead.create` | เว็บฟอร์มลูกค้า — ใบที่เข้ามาไม่มีเจ้าของ รอพนักงานขายกดรับ |
| `GET /crm/leads/{id}/facts` | `integration.crm.lead.read` | workflow engine อ่านข้อเท็จจริง |
| `POST /crm/leads/{id}/stage` | `integration.crm.lead.stage` | workflow engine บันทึกขั้นที่ตัดสินแล้ว |

`sourceOf()` ใน `lead-intake.service.ts` เอา `sourceCode` **จาก API key** ก่อน body
ไม่มีทั้งคู่ = 422 ไม่มี fallback เป็น "unknown"

> **`intake` ต่อท้ายตั้งแต่ 21 ก.ย. 2569** — เดิมเส้นนี้คือ `POST /crm/leads` ซึ่ง
> `ExternalLeadsController.create` ผูกอยู่ด้วย และ controller ตัวนั้น register ก่อนใน
> `crm.module.ts` **เส้น intake จึงเรียกไม่ถึงเลย** เว็บฟอร์มที่ยิงด้วยกุญแจอย่างเดียว
> ได้ 400 `ต้องระบุ header x-acting-user` ไม่ใช่ Lead · `yarn openapi` เตือนแล้วเมื่อมี
> handler สองตัวผูก METHOD+path เดียวกัน

### สิทธิ์ทั้งหมด

ของคน (`libs/share/src/policy/permissions.ts`):
`crm.customer.read` · `crm.customer.read.all` · `crm.customer.manage` ·
`crm.customer.sensitive.read` (CM-08 เปิดเลขผู้เสียภาษี) ·
`crm.customer.dedup.override` (CM-03) · `crm.customer.financial.read` (C360-02) ·
`crm.sales.read` · `crm.sales.read.all` · `crm.sales.manage` · `admin.crm.manage`

ของบัญชีบริการ (AUTH-06) — ออกให้กุญแจ API ที่หน้า **กุญแจ API**
(`admin.integration.manage`) ส่วนหน้า Role แสดงเป็น `type: service` และ **ติ๊กให้
role ของคนได้** ตั้งแต่ 17 ก.ย. 2569 ไม่มี seed role ไหนถืออยู่:
`integration.crm.lead.read` · `integration.crm.lead.stage` ·
`integration.crm.lead.create` · `integration.crm.customer.read` ·
`integration.crm.customer.manage` · `integration.crm.sales.read` ·
`integration.crm.sales.manage` · `integration.crm.admin.manage`

---

## 5. สิ่งที่ยังไม่มี — ไม่ใช่ 501 แต่ไม่มีเลย

| เรื่อง | สภาพจริง |
|---|---|
| `POST /sale-orders` · `POST /quotations` ที่ระดับ collection | **ไม่มี** ทั้งคู่ต้องเปิดผ่านโอกาสการขาย (`/opportunities/{id}/...`) |
| รวมทะเบียนลูกค้าซ้ำ (CM-09 / CD-122) | ทำแล้ว 29 ก.ย. 2569 — `GET /customers/:id/merge-preview?into=` + `POST /customers/:id/merge` (`admin.customer.merge`, เหตุผลบังคับ, audit) ย้ายทุกเอกสารไปรายหลัก รายซ้ำเป็น alias ปิดใช้งาน (`CustomerMergeService`) · ปุ่ม "รวมเข้ากับลูกค้าอื่น" บนหน้าลูกค้า |
| product master / BOQ | ไม่มี `unitCost` ต่อบรรทัดใบเสนอราคากรอกมือ รอ CD-11/CD-12 |
| เปิดใบที่ปิดแล้วใหม่ | ไม่มีทางกลับจาก won/lost |
| **CRM ใน MCP** | **ไม่มี tool CRM สักตัว** — `mcp-tools.ts` พูดถึง CRM แค่ในคอมเมนต์สองบรรทัด (`:140`, `:204`) ที่เผื่อไว้ว่าจะมีวันหนึ่ง chat วันนี้ครอบคลุมแค่ request |
| summary/description ใน OpenAPI ของ CRM | **ปิดแล้ว 18 ก.ย. 2569** — 63 จาก 79 operation มี `summary` ที่เหลือ 16 ตัวเป็นกลุ่ม admin ซึ่งไม่ใช่ทางเดินของงานขาย |

> **เหลือข้อเดียวก่อน chat CRM จะทำรายการได้** — spec อ่านรู้เรื่องแล้วและ Postman
> ยิงโดนทั้ง 79 เส้น แต่ **ยังไม่มี tool CRM ให้โมเดลเรียกสักตัว**
> prompt ที่มีวันนี้คือ `docs/aiyara-prompt/AIYARA_CRM_SYSTEM_PROMPT_V1.md` ซึ่ง
> อธิบายวงจรและพาไปหน้าจอ ไม่ได้ลงมือทำแทน

---

## 6. อ่านต่อที่ไหน

ความรู้เชิงลึกของ CRM อยู่ใน doc comment ของซอร์ส ไม่ได้อยู่ในเอกสารชุดนี้ ที่คุ้มค่าที่สุด:

| ไฟล์ | อธิบายอะไร |
|---|---|
| `docs/aiyara-prompt/AIYARA_CRM_SYSTEM_PROMPT_V2.md` | วงจรทั้งหมดในรูปที่วางลง chat platform ได้ (v1 ยังอยู่แต่เนื้อหาค้างก่อน CD-65/CD-76) |
| `services/core-service/src/crm/opportunity-activities.service.ts` | กิจกรรมและการติดตาม — ทำไม `refreshSummary` ต้องเป็นทางเดียวที่เขียนสามคอลัมน์นั้น |
| `services/core-service/src/crm/opportunity-stale-monitor.service.ts` | sweep ดีลเงียบ และเหตุผลที่ประทับธงก่อนส่งแจ้งเตือน |
| `services/core-service/src/crm/quotation-print.service.ts` | ฉบับพิมพ์ที่ไม่ดึงต้นทุน จึงอ่านได้ด้วย `crm.sales.read` |
| `services/core-service/src/crm/crm.module.ts` | ทำไม module แยกสองชั้น และ export อะไรบ้าง |
| `services/external-service/src/crm/lead-intake.controller.ts` | เหตุผลเต็มของกองกลางและการเอา source จาก API key |
| `services/core-service/src/crm/lead-workflow.service.ts` | มติ "Workflow owns Process, Core owns Data" |
| `services/core-service/src/crm/quotations.service.ts:66-80` | วงจรใบเสนอราคาทั้งหมดในห้าบรรทัด |
| `services/core-service/src/crm/sale-orders.service.ts:100-107` | ลำดับการเกิดของทะเบียนลูกค้า |
| `docs/EXTERNAL_API.md` | การยืนยันตัวตนและสองประตู (ไม่มีวงจร CRM) |
