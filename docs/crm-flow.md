# CRM — วงจรการทำงานที่มีอยู่จริงในระบบ

เอกสารนี้อธิบายว่า **CRM วันนี้ทำอะไรได้จริง** ไล่จากโค้ดที่รันอยู่ ไม่ใช่จากสเปก
ทุกหัวข้ออ้าง `path:line` ให้ไปอ่านของจริงต่อได้

**ตรวจครั้งล่าสุด 17 ก.ย. 2569** — `yarn jest --testPathPatterns=crm` ใน
`services/core-service` ได้ **17 suites / 162 tests ผ่านทั้งหมด**

> **CRM ไม่ใช่โครงเปล่า** `grep -rn "NotImplementedException\|notImplemented(" services/ libs/`
> ไม่เจออะไรเลย ตัวช่วย `services/core-service/src/common/not-implemented.ts` ถูก
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
          ├─ lose                  → stage lost        opportunities.service.ts:344
          │
          ├─ createForOpportunity  → Quotation v1 draft  quotations.service.ts:206
          │     │
          │     ├─ submit   margin ผ่าน → approved ทันที      quotations.service.ts:354
          │     │           margin ต่ำ  → เปิด request DSC
          │     │                         แล้วรอ → pending_approval
          │     ├─ send     approved → sent               quotations.service.ts:477
          │     ├─ accept   sent → accepted               quotations.service.ts:499
          │     ├─ decline  sent → declined               quotations.service.ts:526
          │     └─ revise   → superseded + v(n+1) draft   quotations.service.ts:584
          │
          └─ open Sale Order   ◀── จุดที่ทะเบียนลูกค้าถูกสร้าง
                               และโอกาสการขายถูกปิดชนะ    sale-orders.service.ts:108
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
| `LeadActivityType` | `call` · `email` · `meeting` · `task` · `note` |
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

---

## 4. API ที่เปิดให้ระบบภายนอก

`docs/openapi/external-crm.json` — **58 path / 74 operation** ทั้งหมดอยู่ใต้
`/api/v1/crm/*` บน external-service

| กลุ่ม | ops | สิทธิ์ที่ใช้ |
|---|---|---|
| customers | 24 | `crm.customer.read` / `crm.customer.manage` · `import` ใช้ `admin.crm.manage` |
| admin (ตั้งค่า CRM) | 16 | `admin.crm.manage` ทั้งหมด |
| leads | 14 | `crm.sales.read` / `crm.sales.manage` · สามตัวเป็น robot-only |
| quotations | 9 | `crm.sales.read` / `crm.sales.manage` |
| opportunities | 8 | `crm.sales.read` / `crm.sales.manage` |
| sale-orders | 3 | `crm.sales.read` / `crm.sales.manage` |

### สองประตูเหมือน request ทุกประการ

71 จาก 74 operation ประกาศครบทั้งคู่ — `@Permissions('integration.crm.*')` สำหรับ
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
| `POST /crm/leads` | `integration.crm.lead.create` | เว็บฟอร์มลูกค้า — ใบที่เข้ามาไม่มีเจ้าของ รอพนักงานขายกดรับ |
| `GET /crm/leads/{id}/facts` | `integration.crm.lead.read` | workflow engine อ่านข้อเท็จจริง |
| `POST /crm/leads/{id}/stage` | `integration.crm.lead.stage` | workflow engine บันทึกขั้นที่ตัดสินแล้ว |

`sourceOf()` ใน `lead-intake.service.ts` เอา `sourceCode` **จาก API key** ก่อน body
ไม่มีทั้งคู่ = 422 ไม่มี fallback เป็น "unknown"

### สิทธิ์ทั้งหมด

ของคน (`libs/share/src/policy/permissions.ts`):
`crm.customer.read` · `crm.customer.read.all` · `crm.customer.manage` ·
`crm.customer.sensitive.read` (CM-08 เปิดเลขผู้เสียภาษี) ·
`crm.customer.dedup.override` (CM-03) · `crm.customer.financial.read` (C360-02) ·
`crm.sales.read` · `crm.sales.read.all` · `crm.sales.manage` · `admin.crm.manage`

ของเครื่องเท่านั้น ห้ามยกให้ role ของคน (AUTH-06):
`integration.crm.lead.read` · `integration.crm.lead.stage` ·
`integration.crm.lead.create` · `integration.crm.customer.read` ·
`integration.crm.customer.manage` · `integration.crm.sales.read` ·
`integration.crm.sales.manage` · `integration.crm.admin.manage`

---

## 5. สิ่งที่ยังไม่มี — ไม่ใช่ 501 แต่ไม่มีเลย

| เรื่อง | สภาพจริง |
|---|---|
| `POST /sale-orders` · `POST /quotations` ที่ระดับ collection | **ไม่มี** ทั้งคู่ต้องเปิดผ่านโอกาสการขาย (`/opportunities/{id}/...`) |
| รวมทะเบียนลูกค้าซ้ำ (CM-09) | มีแต่คอลัมน์ `mergedIntoCustomerId` / `mergedAt` ไม่มี endpoint — schema comment บอกว่า PO เลื่อนออกจาก MVP |
| product master / BOQ | ไม่มี `unitCost` ต่อบรรทัดใบเสนอราคากรอกมือ รอ CD-11/CD-12 |
| เปิดใบที่ปิดแล้วใหม่ | ไม่มีทางกลับจาก won/lost |
| **CRM ใน MCP** | **ไม่มี tool CRM สักตัว** — `mcp-tools.ts` พูดถึง CRM แค่ในคอมเมนต์สองบรรทัด (`:140`, `:204`) ที่เผื่อไว้ว่าจะมีวันหนึ่ง chat วันนี้ครอบคลุมแค่ request |
| summary/description ใน OpenAPI ของ CRM | **71 จาก 74 operation ไม่มี summary** — มีแค่สาม route robot-only ที่เขียนมือไว้ ส่วนที่เหลือ generator ก๊อป handler มาแต่ไม่เคยมีใครเขียน `@ApiOperation` |

> **สองข้อล่างคือสิ่งที่ต้องปิดก่อนทำ chat CRM** — โมเดลที่อ่าน tool catalogue ของ CRM
> วันนี้จะเห็น description ว่างทั้งหมด และไม่มี tool ให้เรียกตั้งแต่แรก

---

## 6. อ่านต่อที่ไหน

ความรู้เชิงลึกของ CRM อยู่ใน doc comment ของซอร์ส ไม่ได้อยู่ในเอกสารชุดนี้ ที่คุ้มค่าที่สุด:

| ไฟล์ | อธิบายอะไร |
|---|---|
| `services/core-service/src/crm/crm.module.ts` | ทำไม module แยกสองชั้น และ export อะไรบ้าง |
| `services/external-service/src/crm/lead-intake.controller.ts` | เหตุผลเต็มของกองกลางและการเอา source จาก API key |
| `services/core-service/src/crm/lead-workflow.service.ts` | มติ "Workflow owns Process, Core owns Data" |
| `services/core-service/src/crm/quotations.service.ts:66-80` | วงจรใบเสนอราคาทั้งหมดในห้าบรรทัด |
| `services/core-service/src/crm/sale-orders.service.ts:100-107` | ลำดับการเกิดของทะเบียนลูกค้า |
| `docs/EXTERNAL_API.md` | การยืนยันตัวตนและสองประตู (ไม่มีวงจร CRM) |
