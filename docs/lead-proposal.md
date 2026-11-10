# Proposal จาก Vuvagent: แนะนำสินค้า → เขียน proposal (9 พ.ย. 2569)

Vuvagent มี agent "Proposal Writer" หนึ่งตัวที่เปิด endpoint ให้ 2 ตัว (สเปกของ Vuvagent:
`proposal-endpoints-api.md`) ระหว่างสองขั้นมีการตัดสินใจของ sale คั่นอยู่ คือ sale ต้องเลือกสินค้าเอง
จึงเรียกต่อกันรวดเดียวไม่ได้ ฝั่ง CTD ใช้ท่อเดิมของ `lead.find` และ `lead.research`
(`agent-records/`) และเพิ่ม action อีก 2 ตัว ไม่ต้องมีตารางใหม่หรือ migration

## ข้อตัดสินของผู้ใช้

| เรื่อง | ตัดสิน |
|---|---|
| ขั้นตอนบนหน้าจอ | 2 ปุ่ม: แนะนำสินค้า แล้ว sale เลือกสินค้าเพื่อเขียน proposal (ไม่ให้ AI เลือกเอง) |
| ไฟล์ .docx | CTD ดาวน์โหลดเองตอนได้ callback เพราะ `proposal_url` หมดอายุใน 7 วัน แล้วเก็บเป็นไฟล์ Lead `kind=proposal` |
| ตำแหน่ง UI | การ์ด Proposal ใหม่บนหน้า Lead ข้างการ์ด Research |

## เส้นทาง

```
Sale เปิดหน้า Lead (การ์ด Proposal)
 │
 ├─1 กด "แนะนำสินค้า"   POST leads/{id}/suggest-products
 │     record A: lead.suggest_products, processing
 │     ──► POST {baseUrl}/v1/endpoints/ep_a188…  {agent_record_id: A, lead_id}  → 202
 │         Vuvagent อ่าน Lead (crm/ai/leads/:id), จัดอันดับสินค้า 1–5 ตัว          (< 1 นาที)
 │         PATCH crm/ai/leads/:id/intake-data  {product_suggestions: {products, agent_record_id}}
 │     ◄── PATCH agent-records/A  {status: done, result: {lead_id, products[]}}
 │
 ├─2 การ์ดแสดง products[] (product + reason) ตัวละ 1 ปุ่ม
 │
 ├─3 กด "เขียน proposal: D-DEBT"   POST leads/{id}/proposal {product}
 │     record B: lead.write_proposal, processing
 │     ──► POST {baseUrl}/v1/endpoints/ep_d85e…  {agent_record_id: B, lead_id, product}  → 202
 │         Vuvagent เขียน .docx                                                     (2–6 นาที)
 │     ◄── PATCH agent-records/B  {status: done, result: {product, solution, proposal_url, match_reason}}
 │
 └─4 CTD (หลัง commit ของข้อ 3) ดาวน์โหลด proposal_url → lead_files kind=proposal, source=agent
       result.proposal_file_id = id ของไฟล์ (ล้ม = result.proposal_file_error, record ยัง done)
       → อีเมลขอบคุณ `attach_proposal` ใช้ไฟล์ proposal ล่าสุด (sales-email-flow.md)
```

กดสินค้าตัวอื่น = record ใหม่และไฟล์ใหม่ ไฟล์เก่ายังอยู่ และอีเมลจะใช้ไฟล์ล่าสุด
การลองใหม่ก็คือกดใหม่ ระบบสร้าง `agent_record_id` ใหม่ทุกครั้งตามที่สเปกกำหนด

## Action (`AGENT_ACTIONS`)

| action | ปุ่ม / route | ส่งไป Vuvagent | ผลกลับ | timeout ตั้งต้น |
|---|---|---|---|---|
| `lead.suggest_products` | `POST leads/:id/suggest-products` | `agent_record_id`, `lead_id` | `result.products[{product, reason}]` + `intakeData.product_suggestions` | 10 นาที |
| `lead.write_proposal` | `POST leads/:id/proposal` body `{product}` | `agent_record_id`, `lead_id`, `product` | `result.proposal_url` → ไฟล์ Lead | 30 นาที |

สิทธิ์ของทั้งสอง action เหมือน `lead.research`: ดูได้ด้วย `crm.lead.read` และสั่งงานได้ด้วย `crm.lead.manage`
ถ้า Lead อยู่นอกขอบเขตของผู้กด ระบบตอบ 404 ก่อนสร้าง record (SCOPE-03)

`product` ไม่ได้ตรวจกับรายชื่อฝั่ง CTD เพราะรายชื่อสินค้า 20 ตัวเป็นของ Vuvagent ถ้าค่าผิด Vuvagent จะปิดงานเป็น
`failed` พร้อมข้อความ `Unknown product "…"` ปุ่มบนการ์ดส่งค่าตามที่ข้อ 1 ตอบกลับมาทุกตัวอักษร

## ตั้งค่า (หน้า Integrations → "การเชื่อมต่อที่เราเรียก")

1 action ต่อ 1 แถว `outbound_connections` (`VuvagentClient.dispatch` หาแถวด้วย company + action) จึงต้องตั้ง **2 แถว**
ที่ใช้ API key ใบเดียวกัน ช่อง URL วาง URL เต็มของ endpoint ได้เลย เพราะ `splitVuvagentUrl` แยก base กับ endpoint id ให้

| action | URL |
|---|---|
| `lead.suggest_products` | `https://vuvagent.say2us.com/v1/endpoints/ep_a188bc8d5b2c47c4aecc09c02c30d6fe` |
| `lead.write_proposal` | `https://vuvagent.say2us.com/v1/endpoints/ep_d85ead7483574ecb813c96850c1b45df` |

key ที่ Vuvagent ใช้ตอนเรียกกลับคือ key "Lead API" (`lead-only-access.md`) ซึ่งต้องมี `integration.agent.record.update`
(ปิดงาน), `integration.crm.lead.read.all` (อ่าน Lead) และ `integration.crm.lead.update` (เขียน `product_suggestions`)

## ดาวน์โหลดไฟล์ (ข้อ 4)

- ทำหลัง transaction ของ `complete()` commit แล้วเท่านั้น callback ซ้ำจะได้ 409 ก่อนถึงขั้นดาวน์โหลด จึงไม่มีไฟล์ซ้ำ
- รับเฉพาะ `proposal_url` ที่ host ตรงกับ `baseUrl` ของ connection และผ่าน `addressProblems()` (กัน SSRF)
  timeout 30 วินาที, ขนาดไม่เกิน 20 MB, ชนิดไฟล์ตาม `LEAD_FILE_TYPES`
- ถ้าดาวน์โหลดล้ม record ยังเป็น `done` เพราะ Vuvagent ทำงานสำเร็จแล้ว ระบบใส่ `result.proposal_file_error` ไว้
  การ์ดจะแสดงลิงก์เดิมพร้อมวันหมดอายุ (`updatedAt` ตอนปิดงาน + 7 วัน) และจะไม่ตอบ error กลับไปให้ Vuvagent

## Error จาก Vuvagent

| เวลา | อาการ | ความหมาย |
|---|---|---|
| ตอนส่งงาน | record `failed` "ส่งงานให้ agent ไม่สำเร็จ: HTTP 401" | key ผิด |
| ตอนส่งงาน | `HTTP 404 not_found` | endpoint id ผิด, endpoint ถูกปิด หรือเป็นของ agent อื่น |
| ตอนส่งงาน | `HTTP 409 no_playbook` | endpoint ยังไม่ผูก playbook ที่ publish แล้ว |
| ปิดงาน | `failed` `Lead … not readable` | key "Lead API" อ่าน Lead นี้ไม่ได้ |
| ปิดงาน | `failed` `Unknown product "…"` | `product` ไม่ใช่ค่าที่ Vuvagent รู้จัก |
| ปิดงาน | `failed` `create_proposal returned no download link` | Vuvagent สร้างไฟล์ไม่สำเร็จ |

## ที่ยังเปิดอยู่

- **Header ของ key:** สเปกใหม่เขียน `Authorization: Bearer` แต่ `VuvagentClient` ส่ง `x-api-key` (ใช้ได้กับ `lead.find`
  และ `lead.research`) ให้ลองปุ่ม "ทดสอบ" ของแถวใหม่ก่อน ถ้าได้ 401 ค่อยส่งทั้งสอง header ซึ่งจะกระทบ action เดิมด้วย
- **Header ของบริษัท:** ทุกการเรียก agent (รวมปุ่ม "ทดสอบ") ส่ง `x-organization-id` = `companyId` ของ CTD (10 พ.ย. 2569)
