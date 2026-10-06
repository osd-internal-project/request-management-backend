# External API — วิธียืนยันตัวตนและวิธีตรวจสอบ

**ทุก API ที่ระบบภายนอกเรียกได้อยู่ที่ external-service พอร์ตเดียว** —
`3003` ในคอนเทนเนอร์ publish เป็น `3503` core-service (`3002`) เหลือแต่ API
ของหน้าเว็บ และไม่มี endpoint ไหนที่ระบบภายนอกเรียกได้อีกแล้ว

แยกเป็น service ของตัวเองเพราะ **การยืนยันตัวตนคนละแบบกับหน้าเว็บ** ไม่ใช่เพราะ
อยากได้พอร์ตใหม่ หน้าเว็บส่ง token ของคน ส่วนที่นี่ส่ง credential ของเครื่อง
แล้วบอกว่าทำแทนใคร ก่อนหน้านี้ของแบบนี้กระจายอยู่สามคำนำหน้า (`/request/*`,
`/integrations/crm/leads`, `/integrations/approval-cases`) โดย auth ไม่เหมือนกัน
ทั้งสามแบบ และแบบหนึ่งมี `@Permissions` ที่ถูกคอมเมนต์ทิ้งไว้

รายการ endpoint ไม่ได้อยู่ที่นี่ — **หนึ่งไฟล์ต่อหนึ่ง module** ทุกไฟล์สร้างด้วย
`yarn openapi` (เดิมเป็นไฟล์รวม `external-api.json` ไฟล์เดียว 70 path 221 KB
คนที่ต่อแค่ CRM ต้องอ่านผ่าน request กับ approval ไปก่อน)

| ไฟล์ | paths | สำหรับ |
|---|---|---|
| [`openapi/external-request.json`](./openapi/external-request.json) | 10 | คำขอตั้งแต่เปิดจนปิด |
| [`openapi/external-crm.json`](./openapi/external-crm.json) | 62 | ลูกค้า, Lead, โอกาสการขาย, ใบเสนอราคา |
| [`openapi/external-approval.json`](./openapi/external-approval.json) | 1 | เปิดเคสอนุมัติจากโมดูลอื่น |
| [`openapi/external-flow.json`](./openapi/external-flow.json) | 1 | ติดตามดีลทั้งสายในครั้งเดียว |
| [`openapi/external-presales.json`](./openapi/external-presales.json) | 5 | Solution ของดีล (อ่าน) |
| [`openapi/external-legal.json`](./openapi/external-legal.json) | 5 | คลังสัญญา (อ่าน) |
| [`openapi/external-pm.json`](./openapi/external-pm.json) | 6 | โครงการ — อ่าน และเปิดจากสัญญาที่ลงนามแล้ว |
| [`openapi/external-delivery.json`](./openapi/external-delivery.json) | 3 | แผนส่งมอบ งวดวางบิล การส่งต่อทีมบริการ (อ่าน) |
| [`openapi/external-support.json`](./openapi/external-support.json) | 7 | งานบริการ — ทะเบียนอุปกรณ์ สิทธิ์บริการ เปิดใบสั่งงาน |
| [`openapi/external-mcp.json`](./openapi/external-mcp.json) | 1 | คำอธิบาย JSON-RPC — ไม่ใช่ REST |
| [`openapi/external-tools.json`](./openapi/external-tools.json) | 26 tools | tool-caller (`yarn tools`) |

Postman collection สร้างจากสามไฟล์แรกด้วย `yarn postman` เขียนลง
`../docs/postman/Request-Form-External-{Request,CRM,Approval}.postman_collection.json`

**อย่าลอกรายการ endpoint มาไว้ที่นี่อีกชุด** — สองชุดจะเริ่มไม่ตรงกันทันทีที่แก้อันเดียว
รายการรวมทุกเส้นพร้อมสิทธิ์ทั้งสองประตูคือ [`EXTERNAL_API_INDEX.md`](./EXTERNAL_API_INDEX.md)
ซึ่ง `yarn openapi` เขียนใหม่ทุกครั้ง และลำดับการเรียกตามสายงานตั้งแต่ Lead จนถึงงานบริการอยู่ที่
[`EXTERNAL_API_GUIDE.md`](./EXTERNAL_API_GUIDE.md) — **ส่งไฟล์นั้นให้ทีมที่มาเชื่อมต่อเป็นไฟล์แรก**

**enum ขอบเขต และฟิลด์บังคับในสเปกมาจาก class-validator** ไม่ใช่จาก `@ApiProperty`
อย่างเดียว — Swagger อ่านแค่ `@ApiProperty` จึงเคยทิ้งฟิลด์ของ CRM ไป 177 ตัวและ query ของหน้า
รายการทั้งหมด (`GET /crm/leads` ไม่มี `view`) `scripts/openapi-validators.ts` เติมกลับจาก
metadata ที่ `ValidationPipe` ใช้จริง ⇒ **เพิ่ม `@IsIn` บน DTO = enum โผล่ในสเปก tool และ
Postman ทันที** ไม่ต้องเขียน `@ApiProperty({ enum })` ซ้ำ ที่ยังต้องเขียนเองคือ `example` กับ
`description` — validator ไม่รู้ว่าค่าตัวอย่างที่ดีคืออะไร

## โครงสร้างตาม module

| Module | operations | เนื้อหา |
|---|---|---|
| `api/v1/request/*` | 11 | คำขอ — เปิด, ติดตาม, ดำเนินการ, ปิด |
| `api/v1/crm/*` | 79 | ทะเบียนลูกค้า, Lead, โอกาสการขาย, ใบเสนอราคา, ใบสั่งขาย, ตั้งค่า CRM |
| `api/v1/approval/*` | 1 | เปิดเคสอนุมัติจากโมดูลอื่น (APV-07) |
| `api/v1/flow/*` | 1 | ติดตามดีลทั้งสาย ดีล → โครงการ (6 ต.ค. 2569) |
| `api/v1/presales/*` | 5 | Solution ของดีล — อ่านอย่างเดียว |
| `api/v1/legal/*` | 5 | คลังสัญญา — อ่านอย่างเดียว |
| `api/v1/pm/*` | 7 | โครงการ — อ่าน + เปิดจากสัญญา |
| `api/v1/delivery/*` | 3 | การส่งมอบของโครงการ — อ่านอย่างเดียว |
| `api/v1/support/*` | 8 | งานบริการ — อ่าน + เปิดใบสั่งงานบริการ |
| `api/v1/mcp` | 1 | tool-caller — ทุก tool ผ่าน endpoint เดียว |

โค้ดวางตามนี้ตรง ๆ: `services/external-service/src/{request,crm,approval,flow,presales,legal,pm,delivery,support,mcp}/`
และ `auth/` ที่รวมเรื่อง credential ของเครื่องไว้ที่เดียว **คำถามว่า
"เครื่องจักรแตะอะไรได้บ้าง" จึงตอบได้ด้วยการอ่านไดเรกทอรีเดียว**

---

## 0. สองประตู — อ่านข้อนี้ก่อนตรวจสอบสิทธิ์

ทุก route บนพอร์ตนี้ประกาศสองอย่าง และมันตอบคำถามต่างกัน

| | ถามว่าอะไร | ประกาศด้วย | ตรวจโดย | ตรวจเมื่อไร |
|---|---|---|---|---|
| ประตูของเครื่อง | integration ตัวนี้เรียก endpoint นี้ได้ไหม | `@Permissions('integration.…')` | `PolicyGuard` (global) | **ก่อน** สลับตัวตน |
| ประตูของคน | คนใน `X-Acting-User` ทำสิ่งนี้ได้ไหม | `@ActingPermissions('crm.…')` | `ActingPolicyGuard` | **หลัง** สลับตัวตน |

ลำดับนี้จงใจ และเปลี่ยนไม่ได้ — `ActingUserGuard` เป็น route guard จึงทำงานหลัง
global guard ทุกตัว ถ้าสลับตัวตนก่อน `PolicyGuard` คนที่ถือ `request.create`
จะเดินผ่านประตูที่ทำไว้ให้หุ่นเท่านั้น (เหตุผลเต็มอยู่ใน
`services/external-service/src/auth/acting-user.guard.ts`)

**ผลที่ตามมาคือเหตุผลที่ต้องมีประตูที่สอง** — หลังสลับตัวตนแล้วไม่มีอะไรตรวจ
สิทธิ์ของคนเลย ฝั่ง request รอดมาได้เพราะ `RequestsService` เรียก `assertMayAct`
ตรวจซ้ำข้างใน แต่ CRM ประกาศ `crm.*` ไว้บน controller อย่างเดียว ถ้าเปิด CRM
ออกมาโดยไม่มี `@ActingPermissions` บัญชีบริการจะแก้ข้อมูลลูกค้าในนามคนที่ไม่มี
สิทธิ์แก้ได้

`@ActingPermissions` ต้องขอเท่ากับที่ route ของหน้าเว็บขอ ไม่ใช่น้อยกว่า —
`crm-route-parity.spec.ts` fail ถ้าไม่ตรง ทั้ง 72 คู่

### สี่ route ที่ไม่มีประตูของคน และเป็นเจตนา

| route | ทำไมไม่มีคน |
|---|---|
| `POST /api/v1/request/intake` | ระบบยื่นคำขอในนามตัวเอง `source: "system"` (REQ-10) |
| `POST /api/v1/crm/leads/intake` | เว็บฟอร์มของลูกค้า — คนกรอกคือลูกค้า ไม่ใช่พนักงาน |
| `GET\|POST /api/v1/crm/leads/{id}/facts\|stage` | workflow engine บันทึกขั้นที่ตัดสินแล้ว |
| `POST /api/v1/approval/cases` | โมดูลอื่นเปิดเคส ไม่ใช่คนกด (APV-07) |

> **`intake` ต่อท้ายตั้งแต่ 21 ก.ย. 2569** — ก่อนหน้านี้เส้นนี้คือ `POST /crm/leads`
> เปล่า ๆ ซึ่งชนกับ `ExternalLeadsController.create` ที่บังคับ `X-Acting-User` และ
> **ถูกบังจนเรียกไม่ถึงเลย** เว็บฟอร์มที่ยิงมาตามเอกสารเดิมได้ 400 ไม่ใช่ Lead

สี่เส้นนี้ **ห้ามส่ง** `X-Acting-User` และมีแต่ประตูของเครื่อง audit จึงบันทึก
ชื่อบัญชีบริการ ซึ่งถูกต้องแล้ว — การใส่ชื่อคนให้มันคือการบันทึกว่ามีคนทำสิ่งที่
ไม่มีใครทำ เพิ่มเส้นที่ห้าได้ แต่ต้องประกาศเหตุผลไว้ในไฟล์นั้น ไม่ใช่ทำโดยปริยาย

---

## 1. ทุก request ต้องมีสองอย่าง

```
Authorization: Bearer <ค่า>
X-Acting-User: <อีเมลของคนที่ระบบกำลังทำแทน>
```

`X-Acting-User` ไม่ใช่ของเสริม — `ActingUserGuard` สลับ principal เป็นคนนั้นก่อน
handler ทำงาน ผลคือขอบเขตการมองเห็น, `assertMayAct`, นาฬิกา SLA และ timeline
บันทึกเป็น **ชื่อคนจริง** ไม่ใช่ชื่อบัญชีบริการ ขาด header นี้แล้วยิงไม่ผ่าน

`X-Company-Id` ใส่เพิ่มได้เมื่อคนนั้นอยู่หลายบริษัท เว้นว่าง = บริษัทหลักของเขา

---

## 2. `Bearer` รับสองแบบ และส่งเหมือนกันทั้งคู่

| | Keycloak access token | API key |
|---|---|---|
| หน้าตา | JWT | ขึ้นต้น `rfk_` |
| อายุ | สั้น ต้องขอใหม่ | **ไม่หมดอายุ** (เว้นแต่ตั้ง `--days`) |
| ยกเลิก | รอหมดอายุ | `yarn apikey:revoke` มีผลทันที |
| ได้มาอย่างไร | `yarn mcp:token` หรือ `client_credentials` ตรง ๆ | `yarn apikey:issue` |

**เครื่องต้องใช้ key เท่านั้น** — `client_credentials` token ที่ยิงตรงมาโดยไม่มีแถวใน
`api_keys` ได้ `FORBIDDEN` เพราะไม่มีที่ให้อ่านสิทธิ์ ตารางข้างบนคงคอลัมน์ token ไว้เพราะ
**คน**ยังใช้ token ของตัวเองกับ `POST /api/v1/mcp` ได้

**key บอกทั้ง *เข้าได้ไหม* และ *ทำอะไรได้*** — external-service แลก `rfk_` key เป็น
Keycloak token ให้เองแล้วส่งต่อเหมือน bearer ธรรมดา (`ApiKeyService`) user-service จึง
ยังเป็นตัวเดียวที่ตรวจ token และไม่ต้องรู้จัก credential แบบที่สองเลย แต่ token ที่แลกมา
ทำหน้าที่เดียวคือ**พิสูจน์ว่าคำขอมาจากระบบเรา** ส่วนสิทธิ์อ่านจาก `scopes` ของ key
(`RemotePrincipalGuard.permissionsOfKey`) ดูข้อ 3.2

> Postman จะใส่ `Bearer ` ให้เองเมื่อเลือก Auth type = Bearer Token — วางเฉพาะ
> ตัวค่า ไม่ต้องพิมพ์คำว่า `Bearer` ซ้ำ ฝั่งเซิร์ฟเวอร์รับทั้งสองแบบอยู่แล้ว
> (`bearerValue()` ตัดคำนำหน้าออกถ้ามี) แต่ไคลเอนต์อื่นอาจไม่ให้อภัยแบบนี้

---

## 3. ตั้งค่าครั้งแรก

### 3.1 `.env` ต้องมี `INTEGRATION_*`

```
INTEGRATION_CLIENT_ID=request-form            # ค่าเดียวกับ KEYCLOAK_CLIENT_ID
INTEGRATION_CLIENT_SECRET=<ค่าเดียวกับ KEYCLOAK_CLIENT_SECRET>
```

**client ตัวไหนก็ได้ที่ขอ `client_credentials` ได้** — service account ไม่ต้องถือ realm
role อะไรทั้งนั้น เพราะสิทธิ์ไม่ได้มาจาก role อีกแล้ว (ดูข้อ 3.2) ที่ตั้งเป็นค่าเดียวกับ
`KEYCLOAK_CLIENT_ID` เพราะไม่มีเหตุผลต้องมีสอง client ไม่ใช่เพราะ client นั้นพิเศษ

ตั้งไม่ครบ → ยิงแล้วได้ `UNKNOWN` พร้อมข้อความ
*"ระบบยังไม่ได้ตั้งค่า INTEGRATION_CLIENT_ID / INTEGRATION_CLIENT_SECRET"*

### 3.2 สิทธิ์ของกุญแจอยู่ที่ `scopes` ไม่ใช่ที่ Keycloak

กุญแจแต่ละใบถือรายการสิทธิ์ของตัวเองในคอลัมน์ `api_keys.scopes` และนั่นคือคำตอบเดียวว่า
มันทำอะไรได้ `RemotePrincipalGuard.permissionsOfKey` อ่านจากตรงนั้น ไม่ได้อ่านจาก
realm role ของ service account อีกแล้ว

> **เคยไม่เป็นแบบนี้** — ก่อนหน้านี้ `scopes` เป็นแค่ตัวตัด (intersect) กับ realm role
> ที่ชื่อตรงกับ permission ผลคือกุญแจที่ถือ `integration.crm.customer.read` อยู่แท้ ๆ
> ตอบ `FORBIDDEN` เพราะไม่มีใครไปสร้าง realm role ชื่อนั้น การเก็บ permission เป็น role
> ในระบบที่มีตาราง permission อยู่แล้วคือรากของปัญหานั้น

ดูว่ากุญแจใบไหนถืออะไร:

```bash
yarn apikey:list
```

ออกกุญแจพร้อมสิทธิ์ — ติ๊กเท่าที่ช่องทางนั้นใช้จริง:

```bash
APIKEY_ISSUE_ALLOW=1 yarn apikey:issue "เว็บไซต์ osd.co.th" \
  --company <company-id> --source website \
  --scope integration.crm.lead.create
```

ทางหลักคือหน้าจอ **ผู้ดูแลระบบ → กุญแจ API** ซึ่งแสดงสิทธิ์จัดกลุ่มตามโมดูลพร้อมคำอธิบายไทย
และออกให้ได้เฉพาะสิทธิ์ที่ catalog บอกว่าเป็นของบัญชีบริการ (`type: 'service'`)

**ข้อควรระวังสองข้อ**

- **`scopes` ว่าง = ไม่มีสิทธิ์เลย** ไม่ใช่ "สิทธิ์เต็ม" เหมือนที่กุญแจก่อน 14 ก.ย. 2569
  เคยได้ กุญแจเก่าต้องเติม scopes ก่อนใช้ต่อ
- **กุญแจถือสิทธิ์ของคนไม่ได้** ทั้ง CLI และหน้าจอปฏิเสธ `crm.*` / `admin.*` — สิ่งที่คน
  ทำได้ตัดสินจาก `X-Acting-User` ที่ประตูที่สอง ไม่ใช่จากกุญแจ

---

## 4. วิธีเข้าถึง

**เครื่องใช้ API key ทางเดียว** (§4.3) — credential แบบเดียวทั้ง REST และ MCP
`client_credentials` token ที่ไม่มีแถวใน `api_keys` ได้ `FORBIDDEN` เพราะไม่มีที่ให้
อ่านสิทธิ์ §4.1 และ §4.2 จึงเหลือไว้สำหรับงานที่ไม่ใช่การเรียก External API

§4.4 เป็น **ช่องทางเรียกอีกแบบ** (MCP) ที่ใช้กุญแจใบเดียวกับ REST

### 4.1 ขอ Keycloak token ตรง ๆ — ใช้เรียก External API ไม่ได้แล้ว

> เก็บไว้เพราะยังใช้ตรวจ realm/secret ว่าตั้งถูกไหม และใช้กับ user-service ได้
> แต่ยิง External API ด้วย token นี้จะได้ `FORBIDDEN` พร้อมข้อความให้ไปออกกุญแจ

```bash
set -a; . ./.env; set +a
curl -s -X POST "$KEYCLOAK_BASE_URL/realms/$KEYCLOAK_REALM/protocol/openid-connect/token" \
  -H 'content-type: application/x-www-form-urlencoded' \
  --data-urlencode grant_type=client_credentials \
  --data-urlencode "client_id=$INTEGRATION_CLIENT_ID" \
  --data-urlencode "client_secret=$INTEGRATION_CLIENT_SECRET" \
| python3 -c "import sys,json;print(json.load(sys.stdin)['access_token'])"
```

ไม่มี dependency ไม่ต้องรันอะไรค้าง แลกกับต้องสั่งใหม่ทุกครั้งที่ token หมดอายุ

### 4.2 `yarn mcp:token` — เครื่องมือ debug ไม่ใช่ทางเข้า

**อย่าเริ่มที่นี่** — นี่คือ §4.1 ห่อเป็น MCP server แบบ stdio เพื่อความสะดวก มันคืน
token ที่ **เรียก External API ไม่ได้** ประโยชน์ที่เหลืออยู่อย่างเดียวคือตรวจว่า realm,
`INTEGRATION_CLIENT_ID` และ secret ตั้งถูกหรือยัง

อย่าสับสนกับ §4.4 ซึ่งเป็น MCP ของ External API จริง ๆ — คนละตัวคนละ transport
ตัวนี้เป็น stdio มี tool เดียวชื่อ `get_keycloak_token` ส่วนตัวนั้นเป็น HTTP
และขน tool ของ External API ทั้งชุด

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_keycloak_token"}}' \
  | yarn --silent mcp:token
```

> realm roles ที่มันรายงาน — รวมถึงคำเตือนเรื่อง `integration.request.create` —
> **ล้าสมัยแล้ว** สิทธิ์ย้ายไปอยู่ที่ `api_keys.scopes` ตั้งแต่ 14 ก.ย. 2569 (§3.2)

### 4.3 API key ที่ไม่หมดอายุ

```
yarn apikey:issue "Aiyara chatbot (prod)" [--days 365]
yarn apikey:revoke <prefix>
yarn apikey:list
```

ใช้แทน token ได้ตรง ๆ ในช่องเดียวกัน — external-service เห็นคำนำหน้า `rfk_` แล้วแลก
เป็น Keycloak token ให้เองก่อนส่งต่อ ผู้เรียกจึงไม่ต้องรู้เรื่อง OAuth เลย

**key เต็มพิมพ์ครั้งเดียวแล้วกู้ไม่ได้** ฐานข้อมูลเก็บแค่ `sha256` ของมัน
(`api_keys.keyHash`) กับ 12 ตัวแรกไว้เรียกชื่อ (`prefix`) — จงใจให้เป็นแบบนี้
เพื่อให้ตาราง `api_keys` รั่วแล้วไม่มีใครเอาไปใช้ต่อได้

⇒ **`keyHash` ใช้เป็น access token ไม่ได้** ทำ key หายแปลว่า "ออกใหม่แล้วเพิกถอน
ของเก่า" ไม่ใช่ "ไปเปิดดูในตาราง"

ออก key ในเครื่อง production ต้องใส่ `APIKEY_ISSUE_ALLOW=1` นำหน้า เป็นกันชน
กันรันผิด `DATABASE_URL`

### 4.4 MCP over HTTP — ให้ LibreChat หรือ chat client ต่อตรง

`POST /api/v1/mcp` — **endpoint เดียวสำหรับทุก tool** ชื่อ tool อยู่ใน body
ไม่ใช่ใน path จึงไม่มี `/mcp/request-types` และ URL เดิมของ REST ไม่ถูกเติม
`/mcp` นำหน้า

```bash
curl -s -X POST http://localhost:3003/api/v1/mcp \
  -H 'content-type: application/json' \
  -H "Authorization: Bearer <token หรือ rfk_...>" \
  -H 'X-Acting-User: someone@example.com' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

เปลี่ยน tool โดยแก้ `params.name` **ไม่ใช่เปลี่ยน URL**:

```json
{"jsonrpc":"2.0","id":2,"method":"tools/call",
 "params":{"name":"request_get_request_types","arguments":{}}}
```

ชื่อ tool ขึ้นต้นด้วย module ที่มันอยู่ (`request_…`) — ใช้ขีดล่างไม่ใช่จุด เพราะ tool
name ถูกตรวจด้วย `^[a-zA-Z0-9_-]{1,64}$` ทั้ง Claude API และตัวอื่น

catalogue มี **26 tool** — `request` ทั้ง 10 เส้น และ CRM อีก 16 ที่**เลือกมา ไม่ใช่เอา
ทั้งก้อน** `CRM_IN_CHAT` ใน `scripts/generate-tools.ts` คือรายการนั้น และคอมเมนต์เหนือมัน
อธิบายว่าทำไม โดยย่อคือ tool catalogue เป็นเมนูที่ยื่นให้โมเดลเลือก ไม่ใช่สัญญา REST —
CRM มี 62 path การยื่นทั้งหมดทำให้โมเดลเลือกแย่ลง ไม่ใช่ดีขึ้น สิบหกเส้นที่เลือกคือสิ่งที่
เซลส์ทำจริงในแชท: ค้นหา, รับ Lead, ขยับสถานะ, บันทึกการติดต่อ, เปิดโอกาสการขาย

เพิ่ม tool = เติมเส้นลง `CRM_IN_CHAT` เท่านั้น generator เก็บเอง และ `McpToolRegistry`
ไม่ยอม boot จนกว่าจะมี handler รองรับ

**CRM ผ่าน MCP ปกปิดฟิลด์อ่อนไหวเท่ากับหน้าจอ** — เลขผู้เสียภาษี (CM-08) และ
ต้นทุน/margin ของใบเสนอราคา หายออกจากคำตอบถ้าคนใน `X-Acting-User` ไม่มีสิทธิ์เห็น
(หายไปเลย ไม่ใช่เป็น `null` ผู้เรียกจึงแยกไม่ออกว่า "ไม่ให้ดู" กับ "ไม่มีค่า")

ฝั่ง REST งานนี้เป็นของ `SensitiveFieldInterceptor` ซึ่ง **MCP ใช้ไม่ได้** — handler
ที่ Nest เห็นคือ `McpController.handle` ที่ไม่มี `@SensitiveResource` และคำตอบถูกห่อ
เป็น `content[].text` ไปก่อนที่ interceptor จะได้จับ `McpToolRegistry.call` จึงปกปิด
เองจาก `x-sensitive-resource` ที่ `yarn openapi` ประทับมากับ tool และ catalogue ที่
ไม่มีฟิลด์นั้นทำให้ boot ไม่ผ่าน — ปฏิเสธดังกว่าปล่อยให้ margin หลุดเงียบ ๆ

รายชื่อ tool ทั้ง 26 ตัวอยู่ที่ `docs/openapi/external-tools.json` และ `tools/list`
อ่านจากไฟล์นั้นตรง ๆ — เพิ่ม endpoint ใน External API แล้วรัน
`yarn openapi && yarn tools` tool ก็เพิ่มเองโดยไม่ต้องแก้โค้ด MCP

> **ไฟล์นี้เป็น input ตอนรัน ไม่ใช่เอกสาร** — `McpToolRegistry` อ่านมันตอน boot และ
> ปิด MCP ทั้งตัวถ้าหาไม่เจอ (service อื่นยังทำงานปกติ จึงไม่มีอะไรฟ้อง) `Dockerfile`
> ของ external-service จึง `COPY` มันเข้า image และ `.dockerignore` มีข้อยกเว้นให้
> ไฟล์นี้ไฟล์เดียวรอดจากการตัด `docs` ทั้งโฟลเดอร์

**ตัวตนผู้ใช้ทำงานสองแบบ ต่างจาก `/request/*` ตรงนี้ที่เดียว**

| credential ที่ส่ง | ระบบรู้จักใครจาก | `X-Acting-User` |
|---|---|---|
| token ของ **คน** (เช่น LibreChat หลัง login) | ตัว token | **ห้ามส่ง** — ส่งแล้วถูกปฏิเสธ |
| `rfk_` key หรือ token บัญชีบริการ | header | **ต้องส่ง** เหมือนเดิม |

ที่ห้ามส่งเมื่อใช้ token ของคน เพราะถ้ายอมรับ ใครที่ login แล้วก็สวมเป็นคนอื่นได้ทันที

#### ตั้งใน LibreChat

**ช่องในหน้า "เพิ่มเซิร์ฟเวอร์ MCP"**

| ช่อง | ค่า |
|---|---|
| ชื่อ | อะไรก็ได้ เช่น `osd-rm-mcp` |
| MCP Server URL | `http://<host>:3503/api/v1/mcp` |
| Transport | **Streamable HTTPS** |
| การยืนยันตัวตน | **OAuth** (แยกคนได้) หรือ **คีย์ API** (ทุกคนเป็นคนเดียวกัน) |

**ถ้าเลือก "คีย์ API"** — ใช้ได้ทันที ไม่ต้องตั้งอะไรเพิ่มใน Keycloak

- ใส่ `rfk_…` เป็นคีย์
- ต้องส่ง header `X-Acting-User` ด้วย เพราะคีย์ผูกกับบัญชีบริการ ไม่ใช่คน
- ทุกคนใน LibreChat จะกลายเป็นคนคนเดียวกันตามอีเมลใน header นั้น

**ถ้าเลือก "OAuth"** — แยกคนได้ แต่ต้องตั้ง client ใน Keycloak ก่อน

`GET /.well-known/oauth-protected-resource` บอก LibreChat เองว่าให้ไป login ที่
realm ไหน และเมื่อยิงมาโดยไม่มี credential จะได้ `401` พร้อม header
`WWW-Authenticate: Bearer resource_metadata="…"` ซึ่งเป็นตัวชี้ทางให้ปุ่มเชื่อมต่อ
โผล่ขึ้นมา — ทั้งสองอย่างนี้ทำไว้แล้ว ไม่ต้องตั้งค่าเพิ่ม

**สิ่งที่ต้องทำเองใน Keycloak** (ทำครั้งเดียว ไม่กระทบ client เดิม)

| ตั้งค่า | ค่า |
|---|---|
| ชื่อ client | เช่น `librechat` |
| Client authentication | **Off** (public client) |
| Standard flow | **เปิด** |
| PKCE method | **S256** |
| Valid redirect URIs | callback ของ LibreChat (ดูจากหน้าตั้งค่าของมัน) |
| Web origins | origin ของ LibreChat |

**ห้ามใช้ `request-form`** เป็น client ของ LibreChat — ตัวนั้นเป็น confidential
client ที่ถือสิทธิ์ Keycloak Admin API และ redirect URI ของมันเป็นของหน้าเว็บ

ผู้ใช้ที่ login ต้องมีสิทธิ์ `request.create` (คือพนักงานทั่วไปที่ถูกจัดเข้าผังทีมแล้ว)
ไม่ต้องมี `integration.*` — สิทธิ์นั้นเป็นของบัญชีบริการเท่านั้น

**เมื่อ login ผ่านแล้ว `X-Acting-User` ห้ามส่ง** — token บอกอยู่แล้วว่าเป็นใคร
ถ้าส่งมาจะถูกปฏิเสธ เพราะถ้ายอมรับ ใครที่ login แล้วก็สวมเป็นคนอื่นได้

#### `PUBLIC_BASE_URL` ต้องเป็น URL ที่ LibreChat มองเห็น

ค่านี้ไปโผล่สองที่: ฟิลด์ `resource` ในเอกสาร discovery และใน header
`WWW-Authenticate` ที่มากับ `401` ตั้งเป็น `localhost` ในขณะที่ LibreChat อยู่คนละ
เครื่อง = ไคลเอนต์ถูกชี้ไปยัง URL ที่มันเข้าไม่ถึง แล้วปุ่มเชื่อมต่อจะวนไม่จบโดยไม่มี
อะไรใน log บอกว่าทำไม ค่าตั้งต้นอยู่ที่ `services/external-service/src/configs/index.ts`

#### ตรวจว่า discovery เดินถูกก่อนไปกด connect

สองเส้นทาง เพราะไคลเอนต์ไม่ตรงกันว่าจะถามอันไหน — เสิร์ฟทั้งคู่และต้องตอบเหมือนกัน:

```bash
curl -s http://<host>:3503/.well-known/oauth-protected-resource
curl -s http://<host>:3503/.well-known/oauth-protected-resource/api/v1/mcp
curl -sI -X POST http://<host>:3503/api/v1/mcp | grep -i www-authenticate
```

สองคำสั่งแรกต้องคืน `resource` และ `authorization_servers` ที่ชี้ไป realm ของจริง
คำสั่งที่สามต้องเห็น `Bearer resource_metadata="…"` — ขาดไปแล้วปุ่มเชื่อมต่อจะไม่โผล่

#### ข้อจำกัดของ transport ที่รู้ตัว

LibreChat ให้เลือก "Streamable HTTPS" แต่ endpoint นี้เป็น `POST` ที่ตอบ
`application/json` ล้วน — **ไม่มี SSE ไม่มี `Mcp-Session-Id` และไม่มี `GET /mcp`**
ซึ่งเพียงพอสำหรับไคลเอนต์ที่ยอมรับคำตอบเป็น JSON ตรง ๆ ตาม Streamable HTTP
ถ้าเจอไคลเอนต์ที่ยืนยันจะเปิด stream ค้างไว้ นั่นคืองานเพิ่ม ไม่ใช่การตั้งค่าผิด

---

---

## 5. ลองยิงจริง

```bash
curl -i \
  -H "Authorization: Bearer rfk_..." \
  -H "X-Acting-User: someone@example.com" \
  http://localhost:3003/api/v1/request/request-types
```

ได้ 200 พร้อมรายการประเภทคำขอ = ครบทุกชิ้น

### 5.1 ตรวจทั้งชุดด้วยสคริปต์เดียว

```bash
API_KEY=rfk_… ACTING_USER=someone@osd.co.th bash scripts/smoke-external.sh
```

REST แปดเคส — สี่เคสที่ต้องผ่าน และสี่เคสที่**ต้องถูกปฏิเสธ** (ไม่มี credential,
กุญแจปลอม, ขาด `X-Acting-User`, อีเมลที่ไม่มีตัวตน) ครึ่งหลังคือส่วนที่พิสูจน์ว่าประตู
ยังปิดอยู่ ไม่ใช่แค่ว่าเปิดได้ ตั้ง `BASE_URL` เพื่อยิงเซิร์ฟเวอร์อื่น

ตามด้วย **MCP เจ็ดเคส** ซึ่งอ่าน body ไม่ใช่ status เพราะ JSON-RPC ตอบ `200` แม้ตอน
ที่มันปฏิเสธ เคสที่สำคัญที่สุดคือ *"tools/list มี tool มากกว่าศูนย์"* — มันจับกรณีที่
catalogue ไม่ได้ติดไปกับ image ซึ่ง MCP จะปิดตัวเองเงียบ ๆ โดย health check ยังเขียว

### 5.2 Postman

`yarn postman` สร้าง collection จากสเปกเดียวกับที่โค้ดประกาศ ลงที่ `docs/postman/`
(Request 11 · CRM 79 · Approval 1 request) import พร้อม environment
`Request-Form-External-Key` แล้ววาง `rfk_…` ลงช่อง `access_token` — collection ตั้ง
auth เป็น bearer ไว้แล้ว กุญแจจึงใช้แทน token ได้ตรง ๆ ไม่ต้องแก้อะไรใน collection

---

## 6. เจอ error แล้วแปลว่าอะไร

รหัสอยู่ในฟิลด์ `code` ของ response — แยกด้วยรหัส ไม่ใช่ข้อความ (ข้อความเปลี่ยนได้)

| รหัส | สาเหตุที่พบบ่อยที่สุด |
|---|---|
| `UNKNOWN` + ข้อความเรื่อง `INTEGRATION_*` | `.env` ยังไม่ได้ตั้ง — ดูข้อ 3.1 |
| `UNAUTHORIZED` | key ผิด / ถูกเพิกถอน / หมดอายุ **หรือ** ไม่ได้ส่ง `Authorization` เลย ทั้งสามกรณีตอบข้อความเดียวกันโดยตั้งใจ ไม่บอกว่าผิดข้อไหน |
| `FORBIDDEN` + `reason: api key required` | ยิงด้วย Keycloak token ไม่ใช่กุญแจ — ออกกุญแจตามข้อ 4.3 |
| `FORBIDDEN` ระบุชื่อ `integration.…` | กุญแจใบนั้นไม่มีสิทธิ์นั้นใน `scopes` — `yarn apikey:list` แล้วออกใบใหม่ให้ครบ ดูข้อ 3.2 |
| `FORBIDDEN` "ผู้ใช้ที่ระบุใน X-Acting-User ไม่มีสิทธิ์" | ประตูที่สอง — คนคนนั้นไม่มีสิทธิ์ ไม่ใช่กุญแจ |
| `NOT_FOUND` ตั้งแต่คำขอแรก | อีเมลใน `X-Acting-User` ยังไม่เคย login เว็บ ให้เข้าเว็บหนึ่งครั้งก่อน |

---

## 7. Swagger UI

`http://localhost:3003/api/docs` — **มีปุ่ม Authorize แล้ว** `main.ts` ของ
external-service ประกาศ `addBearerAuth()` ต่างจาก core-service ที่ไม่ประกาศและ
เป็นเหตุผลที่เอกสารฉบับก่อนบอกให้ไปใช้ Postman

ทุก route ใน Swagger บอกสิทธิ์ทั้งสองประตู — `integration.*` ที่กุญแจต้องถือ และ
`crm.*` / `request.*` ที่คนใน `X-Acting-User` ต้องถือ ใช้หน้านี้ตรวจสอบได้เลยว่า
endpoint ไหนขออะไร

ไฟล์ static ใน `docs/openapi/` ประกาศ scheme ไว้ครบเช่นกัน import เข้า Postman ได้
