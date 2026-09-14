# External API — การยืนยันตัวตน

เอกสารนี้ตอบคำถามเดียว: **จะยิง `/api/v1/external/*` จาก Postman, Swagger UI หรือ
ระบบภายนอกได้อย่างไร** รายการ endpoint ไม่ได้อยู่ที่นี่ — อยู่ที่
[`docs/openapi/external-api.json`](./openapi/external-api.json) (9 endpoints) และ
[`docs/openapi/external-tools.json`](./openapi/external-tools.json) สำหรับ
tool-caller ทั้งสองไฟล์สร้างด้วย `yarn openapi` และ `yarn tools`
**อย่าลอกรายการ endpoint มาไว้ที่นี่อีกชุด** — สองชุดจะเริ่มไม่ตรงกันทันทีที่แก้อันเดียว

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

**key ตัดสินว่า *เข้าได้ไหม* token บอกว่า *ทำอะไรได้*** — core-service แลก `rfk_`
key เป็น Keycloak token ให้เองแล้วส่งต่อเหมือน bearer ธรรมดา (`ApiKeyService`)
user-service จึงยังเป็นตัวเดียวที่ตรวจ token และไม่ต้องรู้จัก credential แบบที่สอง
เลย สิทธิ์ที่ได้จึงเท่ากันทั้งสองแบบ

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

**ใช้ client ตัวเดียวกับ login ไม่ใช่สร้างใหม่** — `yarn keycloak:provision` สร้าง
realm role `integration.request.create` / `integration.approval.create` แล้วยกให้
service account ของ `KEYCLOAK_CLIENT_ID` เอง (`grantIntegrationRoles` ใน
`libs/prisma/keycloak-provision.ts`) สร้าง client เปล่าตัวใหม่แล้วชี้ `INTEGRATION_*`
ไปที่มันจะได้ `FORBIDDEN` เพราะ service account ตัวนั้นไม่มี role

ตั้งไม่ครบ → ยิงแล้วได้ `UNKNOWN` พร้อมข้อความ
*"ระบบยังไม่ได้ตั้งค่า INTEGRATION_CLIENT_ID / INTEGRATION_CLIENT_SECRET"*

### 3.2 ชื่อ realm role ต้องตรงเป๊ะ

service account **ไม่ผ่าน** ตาราง `keycloak_role_mappings` — ตารางนั้นใช้กับ *คน*
เท่านั้น `keycloakRolesOf` (`principal.service.ts`) เอาชื่อ realm/client role
**ดิบ ๆ** มาเป็น permission ดังนั้น role ต้องชื่อ `integration.request.create`
ตรงตัวอักษร ไม่ใช่ตั้งชื่ออื่นแล้วไป map

ตรวจว่าถือ role จริงหรือยัง:

```bash
set -a; . ./.env; set +a
curl -s -X POST "$KEYCLOAK_BASE_URL/realms/$KEYCLOAK_REALM/protocol/openid-connect/token" \
  -H 'content-type: application/x-www-form-urlencoded' \
  --data-urlencode grant_type=client_credentials \
  --data-urlencode "client_id=$INTEGRATION_CLIENT_ID" \
  --data-urlencode "client_secret=$INTEGRATION_CLIENT_SECRET" \
| python3 -c "import sys,json,base64;t=json.load(sys.stdin)['access_token'];s=t.split('.')[1];s+='='*(-len(s)%4);print(json.loads(base64.urlsafe_b64decode(s))['realm_access']['roles'])"
```

ต้องเห็น `integration.request.create` ในผลลัพธ์ ไม่เห็น → `yarn keycloak:provision`

---

## 4. วิธีเข้าถึง

§4.1-4.3 คือวิธี **เอา credential มา** เลือกอย่างเดียวก็พอ ทั้งสามจบลงที่ header
เดียวกัน — `Authorization: Bearer <ค่า>` ส่วน §4.4 เป็น **ช่องทางเรียกอีกแบบ**
(MCP) ที่ใช้ credential จากสามข้อแรกได้ทั้งหมด

| | 4.1 `curl` ตรง | 4.2 `yarn mcp:token` | 4.3 `yarn apikey:issue` |
|---|---|---|---|
| ได้อะไรมา | Keycloak token | Keycloak token (ตัวเดียวกับ 4.1) | API key `rfk_…` |
| อายุ | ตามที่ realm ตั้ง | ตามที่ realm ตั้ง | **ไม่หมดอายุ** เว้นแต่ใส่ `--days` |
| ต้องขอใหม่ไหม | ทุกครั้งที่หมดอายุ | ทุกครั้งที่หมดอายุ | ไม่ต้อง |
| ยกเลิกอย่างไร | รอหมดอายุ หรือหมุน client secret | เหมือน 4.1 | `yarn apikey:revoke` มีผลทันที |
| เหมาะกับ | ทดสอบครั้งเดียว, สคริปต์ CI | ใช้มือระหว่างพัฒนา | ระบบที่รันยาว เช่น chatbot |

**4.1 กับ 4.2 เป็นคำขอเดียวกัน** — MCP แค่ห่อ `client_credentials` ไว้ให้เรียกจาก
เครื่องมือที่คุยกับ MCP ได้ ไม่ใช่ credential คนละชนิด ส่วน 4.3 เป็นคนละชนิดจริง

### 4.1 ขอ Keycloak token ตรง ๆ

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

### 4.2 `yarn mcp:token`

MCP server (stdio) tool เดียวชื่อ `get_keycloak_token` คืนบรรทัด
`Authorization: Bearer …` ที่วางลง Postman ได้เลย พร้อมบอกอายุที่เหลือและ
realm roles ที่ token นั้นถือ — ถ้าไม่มี `integration.request.create` มันจะเตือน
ให้ไปรัน `yarn keycloak:provision` แทนที่จะปล่อยไปเจอ `FORBIDDEN` ตอนยิงจริง

ตั้งใน MCP client:

```json
{ "command": "yarn", "args": ["mcp:token"], "cwd": "<path>/request-management-backend" }
```

เรียกจากบรรทัดคำสั่งเพื่อทดสอบก็ได้ — มันอ่าน JSON-RPC จาก stdin:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_keycloak_token"}}' \
  | yarn --silent mcp:token
```

### 4.3 API key ที่ไม่หมดอายุ

```
yarn apikey:issue "Aiyara chatbot (prod)" [--days 365]
yarn apikey:revoke <prefix>
yarn apikey:list
```

ใช้แทน token ได้ตรง ๆ ในช่องเดียวกัน — core-service เห็นคำนำหน้า `rfk_` แล้วแลก
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
ไม่ใช่ใน path จึงไม่มี `/mcp/request-types` และ URL เดิมทั้งสิบตัวไม่ถูกเติม
`/mcp` นำหน้า

```bash
curl -s -X POST http://localhost:3002/api/v1/mcp \
  -H 'content-type: application/json' \
  -H "Authorization: Bearer <token หรือ rfk_...>" \
  -H 'X-Acting-User: someone@example.com' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

เปลี่ยน tool โดยแก้ `params.name` **ไม่ใช่เปลี่ยน URL**:

```json
{"jsonrpc":"2.0","id":2,"method":"tools/call",
 "params":{"name":"get_request_types","arguments":{}}}
```

รายชื่อ tool ทั้งสิบอยู่ที่ `docs/openapi/external-tools.json` และ `tools/list`
อ่านจากไฟล์นั้นตรง ๆ — เพิ่ม endpoint ใน External API แล้วรัน
`yarn openapi && yarn tools` tool ก็เพิ่มเองโดยไม่ต้องแก้โค้ด MCP

**ตัวตนผู้ใช้ทำงานสองแบบ ต่างจาก `/external/*` ตรงนี้ที่เดียว**

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
| MCP Server URL | `http://<host>:3502/api/v1/mcp` |
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

---

---

## 5. ลองยิงจริง

```bash
curl -i \
  -H "Authorization: Bearer <token หรือ rfk_...>" \
  -H "X-Acting-User: someone@example.com" \
  http://localhost:3002/api/v1/external/request-types
```

ได้ 200 พร้อมรายการประเภทคำขอ = ครบทุกชิ้น

---

## 6. เจอ error แล้วแปลว่าอะไร

รหัสอยู่ในฟิลด์ `code` ของ response — แยกด้วยรหัส ไม่ใช่ข้อความ (ข้อความเปลี่ยนได้)

| รหัส | สาเหตุที่พบบ่อยที่สุด |
|---|---|
| `UNKNOWN` + ข้อความเรื่อง `INTEGRATION_*` | `.env` ยังไม่ได้ตั้ง — ดูข้อ 3.1 |
| `UNAUTHORIZED` | key ผิด / ถูกเพิกถอน / หมดอายุ **หรือ** ไม่ได้ส่ง `Authorization` เลย ทั้งสามกรณีตอบข้อความเดียวกันโดยตั้งใจ ไม่บอกว่าผิดข้อไหน |
| `FORBIDDEN` | token ใช้ได้แต่ service account ไม่มี `integration.request.create` — ดูข้อ 3.2 |
| `NOT_FOUND` ตั้งแต่คำขอแรก | อีเมลใน `X-Acting-User` ยังไม่เคย login เว็บ ให้เข้าเว็บหนึ่งครั้งก่อน |

---

## 7. Swagger UI

`http://localhost:3002/api/docs` — **ตอนนี้ยังไม่มีปุ่ม Authorize** เพราะ
`services/core-service/src/main.ts` ไม่ได้ประกาศ security scheme
(`user-service` และ `scripts/generate-openapi.ts` ประกาศ) ระหว่างนี้ให้ใช้ Postman
หรือ `curl` ส่วนไฟล์ static ใน `docs/openapi/` ประกาศ scheme ไว้ครบ import เข้า
Postman ได้เลย
