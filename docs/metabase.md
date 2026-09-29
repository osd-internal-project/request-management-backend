# Metabase — แดชบอร์ด Request / Approval / SLA (CD-10 · CD-92)

แดชบอร์ดผู้บริหารชุดแรก อ่านข้อมูลจาก database ของระบบผ่าน schema `reporting`
ที่เป็น **read-only และไม่มีข้อมูลอ่อนไหว** — `formData`/`payload` (ซึ่งมี margin,
ส่วนลด ฯลฯ ตาม SCOPE-04) ไม่ถูกเปิดออกไปที่ BI เลย

## ติดตั้ง (3 ขั้น)

**1. สร้าง reporting layer ใน database ของระบบ** (ครั้งเดียว และซ้ำได้เมื่อ view เปลี่ยน):

```bash
psql "$DATABASE_URL" -v mb_password='<รหัสผ่านแข็งแรงของ role metabase_ro>' \
     -f infra/metabase/reporting.sql
```

**2. รัน Metabase:**

```bash
docker compose -f infra/metabase/docker-compose.yml up -d
```

เปิด http://localhost:3300 → สร้างบัญชีแอดมินครั้งแรก
(state ของ Metabase อยู่ใน volume `metabase-app-db-data` แยกจาก database ระบบ)

**3. ต่อ database:** Admin → Databases → Add database → PostgreSQL

| ช่อง | ค่า |
|---|---|
| Host | `host.docker.internal` (Postgres รันบนเครื่อง host) หรือ host จริงของ DB |
| Database name | ตาม `DATABASE_URL` |
| Username | `metabase_ro` |
| Password | ที่ตั้งไว้ในขั้นที่ 1 |
| Schemas | จำกัดเป็น `reporting` เท่านั้น |

## Views ที่มีให้

| View | มีอะไร | ใช้กับ |
|---|---|---|
| `reporting.requests` | คำขอทุกใบ + ประเภท บริษัท แผนก ผู้ขอ สถานะ เวลา cycle_hours | Dashboard Request |
| `reporting.approval_steps` | ทุกชั้นอนุมัติ + ผู้อนุมัติ/ผู้ตัดสินแทน ผลตัดสิน decision_hours | Dashboard Approval |
| `reporting.sla_clocks` | นาฬิกาต่อคำขอ: state, due, breached, running_hours, ทีมผู้รับ, `sla_status` (on_time / late / overdue / on_track / cancelled), นาฬิกาตอบกลับของเคส | Dashboard SLA |
| `reporting.sla_compliance_monthly` | งานที่ปิดแล้ว รายเดือน (เวลาไทย) × ทีมผู้รับ × ประเภท: finished, on_time, late, compliance_pct | Dashboard SLA (CD-50) |
| `reporting.request_events` | timeline ราย event + hours_since_previous (ฐานของรายงานคอขวด REQ-09) | ทั้งสาม |

## Dashboard 1 — Request Overview

| การ์ด | ชนิด | SQL / วิธีตั้ง |
|---|---|---|
| คำขอเปิดใหม่ต่อสัปดาห์ | เส้น | `requests` → count, group by week(`submitted_at`), filter `submitted_at` not null |
| แยกตามสถานะตอนนี้ | แท่ง/โดนัท | `SELECT status, count(*) FROM reporting.requests WHERE NOT is_terminal GROUP BY 1` |
| แยกตามประเภทคำขอ | แท่งแนวนอน | group by `type_name`, ไม่รวม terminal |
| Cycle time เฉลี่ย (ชม.) ต่อประเภท | แท่ง | `SELECT type_name, round(avg(cycle_hours)::numeric,1) FROM reporting.requests WHERE cycle_hours IS NOT NULL GROUP BY 1 ORDER BY 2 DESC` |
| คำขอที่พักอยู่ (on_hold) | ตัวเลข | filter `status = 'on_hold'` |
| ตารางคำขอค้างนานสุด | ตาราง | `SELECT request_no, type_name, requester_unit, status, submitted_at, due_at FROM reporting.requests WHERE NOT is_terminal ORDER BY submitted_at ASC LIMIT 20` |

## Dashboard 2 — Approval

| การ์ด | ชนิด | SQL / วิธีตั้ง |
|---|---|---|
| เวลาตัดสินเฉลี่ยต่อชั้น (role) | แท่ง | `SELECT approver_role, round(avg(decision_hours)::numeric,1) FROM reporting.approval_steps WHERE decided_at IS NOT NULL GROUP BY 1` |
| งานรออนุมัติตอนนี้ ต่อผู้อนุมัติ | แท่งแนวนอน | `SELECT approver, count(*) FROM reporting.approval_steps WHERE step_status = 'waiting' GROUP BY 1 ORDER BY 2 DESC` |
| สัดส่วนผลตัดสิน | โดนัท | group by `decision` (approved / rejected / returned) |
| การอนุมัติผ่าน delegation | ตัวเลข + แนวโน้ม | filter `via_delegation = true` |
| เคสที่วงเงินสูงสุดที่ยังค้าง | ตาราง | `SELECT request_no, subject_type, amount, currency, case_status, step_no, approver FROM reporting.approval_steps WHERE case_status = 'pending' AND step_status = 'waiting' ORDER BY amount DESC NULLS LAST LIMIT 20` |

## Dashboard 3 — SLA

| การ์ด | ชนิด | SQL / วิธีตั้ง |
|---|---|---|
| SLA compliance % (30 วันล่าสุด) | ตัวเลข | `SELECT round(100.0 * count(*) FILTER (WHERE sla_status = 'on_time') / nullif(count(*),0), 1) FROM reporting.sla_clocks WHERE sla_status IN ('on_time','late') AND completed_at > now() - interval '30 days'` |
| เกินกำหนดอยู่ตอนนี้ (คำขอค้างเกินกำหนด) | ตัวเลข (แดง) | filter `sla_status = 'overdue'` |
| Compliance รายเดือน × ทีม | ตาราง/แท่ง | `SELECT month, receiver_unit, sum(on_time), sum(finished), round(100.0*sum(on_time)/nullif(sum(finished),0),1) FROM reporting.sla_compliance_monthly GROUP BY 1,2 ORDER BY 1 DESC, 5` |
| Breach ต่อสัปดาห์ | เส้น | count, group by week(`breached_at`) |
| นาฬิกาที่หยุดพัก (returned / on_hold) | ตัวเลข | filter `state = 'paused'` |
| ใกล้ครบกำหนดใน 24 ชม. | ตาราง | `SELECT request_no, type_code, due_at FROM reporting.sla_clocks WHERE state = 'running' AND due_at BETWEEN now() AND now() + interval '24 hours' ORDER BY due_at` |
| คอขวด: เวลาเฉลี่ยระหว่างขั้น ต่อประเภท | ตาราง/heatmap | `SELECT type_code, event_type, round(avg(hours_since_previous)::numeric,1) AS avg_hours FROM reporting.request_events WHERE hours_since_previous IS NOT NULL GROUP BY 1,2 ORDER BY 3 DESC` |

### คำขอค้างเกินกำหนด — นิยามเดียว (CD-50)

`sla_status = 'overdue'` = ยังไม่ปิด (running/paused) **และ** เลยกำหนดแล้ว — ตัวตรวจ
SLA บันทึก breach ไว้แล้ว หรือกำลังนับอยู่และเลย `due_at` ไปแล้ว. คำขอที่พักนาฬิกาอยู่
ไม่นับว่าเกินกำหนดเพียงเพราะพัก (กำหนดส่งเลื่อนเมื่อกลับมานับ).
นิยามเดียวกันใช้ในหน้า **รายงาน SLA** (`GET /reports/sla-compliance`) — CASE ใน
`reporting.sql` ต้องตรงกับ `SLA_STATUS_SQL` ใน `services/core-service/src/sla/sla-status.ts`
ไม่งั้น `sla-status.spec.ts` ไม่ผ่าน. แก้ view แล้วรัน `reporting.sql` ซ้ำได้ (คอลัมน์ใหม่ต่อท้ายเสมอ).

## Dashboard 4–5 — Adoption (workshop, จากชีต 01_REQUEST_LOG + 02_ACTION_LOG)

แดชบอร์ดผู้บริหารสองชุดที่วัด **การรับ-ใช้ระบบของ 13 ทีม** (ไม่ใช่งานปฏิบัติการ
เหมือน 3 ชุดบน) — ใครเปิดคำขอ ใครถูกขอให้ทำงาน ใครบันทึก Action Log และคำขอ
ไหลข้ามแผนกอย่างไร อ่านจาก schema `workshop` (แยกจาก `reporting` ที่อ่าน
ตารางแอปจริง) ผ่าน view `reporting.adoption_*`

1. **สรุปสถานะการใช้งานระบบ Request ของแต่ละทีม** — ตารางทีมที่เปิดแล้ว/ยังไม่เปิด
2. **OSD Request Log · Executive Summary** — ภาพรวม 92 คำขอ สถานะ ผู้เปิด/ผู้รับ
   flow ข้ามแผนก Target Date และภาระงานรายผู้รับผิดชอบ

ข้อมูลชุดนี้เป็น **sample ที่ seed ให้ตรงตัวเลขใน mockup** (workshop v1.6 ยังไม่มี
ในฐานข้อมูลจริง) — ตัวเลขหลักตรงเป๊ะ ส่วนเซลล์รองคำนวณจากข้อมูลจริง เมื่อมีไฟล์
`<แผนก>_Request_Log_2569_v1.6.xlsx` จริงให้แทนที่ข้อมูลใน `workshop.*` แล้ว view/
แดชบอร์ดใช้ต่อได้ทันที

**ติดตั้ง (ต่อจากขั้น reporting.sql ปกติ):**

```bash
# 1) schema + master data (13 ทีม) — idempotent
psql "$DATABASE_URL" -f infra/metabase/workshop_schema.sql
# 2) ข้อมูลตัวอย่าง 92 คำขอ + 51 action log (สร้างซ้ำได้จาก generator)
python3 infra/metabase/gen_workshop_seed.py > infra/metabase/workshop_seed.sql
psql "$DATABASE_URL" -f infra/metabase/workshop_seed.sql
# 3) reporting views + grant ให้ metabase_ro
psql "$DATABASE_URL" -f infra/metabase/reporting_adoption.sql
# 4) สร้างแดชบอร์ดใน Metabase (auto-detect database ที่มี schema reporting)
MB_URL=http://localhost:3300 MB_SESSION=<session id> \
  python3 infra/metabase/build_adoption_dashboards.py
```

`gen_workshop_seed.py` deterministic — assertion ในตัวการันตีว่า opened ต่อทีม
(64/8/6/5/4/3/2=92), received, action log 51, ปิดงาน 24 และข้ามแผนก 26 ตรง mockup
เสมอ; วันที่อ้างอิง (ครบกำหนด/เลยกำหนด) เทียบกับ `reporting.adoption_asof` = 24 ส.ค.
2569 แก้ที่ view เดียวเมื่อเลื่อน snapshot

## Data Mart — ยอดขายและคำขอค้าง (CD-91)

ข้อมูลที่ผู้บริหารดูเป็นประจำถูก **เตรียมไว้ใน schema `mart`** แทนการรวบรวมด้วยมือ —
core-service สร้างใหม่ทุกชั่วโมง (`DataMartService`, ครั้งแรก 1 นาทีหลังเปิดระบบ) ใน
transaction เดียว ผู้อ่านจึงเห็นชุดเก่าหรือชุดใหม่ทั้งชุด ไม่เห็นครึ่ง ๆ กลาง ๆ

| ตาราง | หนึ่งแถวคือ | ใช้ตอบ |
|---|---|---|
| `mart.fact_sales` | ใบสั่งขาย 1 ใบ (ใบยกเลิกเก็บไว้ `is_cancelled`) · เดือนตามเวลาไทย | ยอดขายรายเดือน/ทีม/ผู้ขาย/ประเภทลูกค้า |
| `mart.fact_pipeline` | ดีลที่เปิดอยู่ 1 ดีล · `weighted_amount` = มูลค่า × โอกาสชนะ (ไม่ระบุ = 0) | pipeline ตามขั้น / เดือนที่คาดปิด |
| `mart.sales_target_actual` | เป้า 1 รายการ (CD-82) กับยอดจริง พยากรณ์ และ % | ตัวเลขเดียวกับหน้า **เป้าและพยากรณ์** (เป้าของฝ่ายนับทุกทีมใต้ฝ่าย, งวดที่ผ่านแล้วไม่นับ pipeline) |
| `mart.open_requests` | คำขอที่ยังไม่จบ 1 ใบ · อายุ (วัน) กลุ่มอายุ และ `sla_status` นิยามเดียวกับ CD-50 | คำขอค้างตอนนี้ ตามทีม/ผู้รับผิดชอบ |
| `mart.request_backlog_daily` | วัน × บริษัท × ทีม × ประเภท × สถานะ | แนวโน้มคำขอค้าง — แถวของวันนี้เขียนทับทุกรอบ วันก่อน ๆ ไม่ถูกแตะอีก |
| `mart.refresh_log` | ตาราง 1 ตาราง: สร้างล่าสุดเมื่อไร กี่แถว ใช้เวลากี่ ms | การ์ด "ข้อมูล ณ" |

"ยังไม่จบ" = ไม่ใช่ draft / rejected / closed / cancelled — `completed` ยังนับ เพราะรอผู้ขอตรวจรับ

**ติดตั้ง:** migration `20260929220000_data_mart` สร้าง schema และตาราง → รัน `reporting.sql`
ซ้ำเพื่อ grant ให้ `metabase_ro` → ตาราง mart ถูกเติมเองภายใน 1 นาทีหลัง core-service เริ่ม
(หรือกด **ปรับปรุงตอนนี้** ที่หน้า ตั้งค่า BI / `POST /admin/bi/mart/refresh`) →
สร้างแดชบอร์ดด้วย `python3 infra/metabase/build_mart_dashboard.py` (ดู docstring)
แล้วเพิ่มเลข dashboard ที่หน้า ตั้งค่า BI

ตั้งรอบได้ด้วย `MART_REFRESH_INTERVAL_MS` (ค่าเริ่มต้น 3600000; 0 = ปิด). SQL ที่สร้าง mart อยู่ใน
`services/core-service/src/bi/data-mart.repository.ts` และ `make smoke` รันมันบน DB จริงทุกครั้ง
— ตาราง mart เป็นตารางธรรมดาไม่ใช่ view เพื่อไม่ให้ migration ที่แก้คอลัมน์ต้นทางในอนาคตล้ม

### Dashboard 6 — ยอดขายและคำขอค้าง

| การ์ด | ชนิด | อ่านจาก |
|---|---|---|
| ข้อมูล ณ | ตัวเลข | `refresh_log` |
| ยอดขายเดือนนี้ | ตัวเลข | `fact_sales` ไม่รวมใบยกเลิก |
| คำขอค้างตอนนี้ / เกินกำหนดอยู่ตอนนี้ | ตัวเลข | `open_requests` |
| ยอดขายรายเดือน (12 เดือน) · ยอดขายเดือนนี้ตามทีม | แท่ง | `fact_sales` |
| เป้า vs ยอดจริง งวดนี้ | ตาราง | `sales_target_actual` |
| Pipeline ตามขั้น · ถ่วงน้ำหนักตามเดือนที่คาดปิด | แท่ง | `fact_pipeline` |
| แนวโน้มคำขอค้างรายวัน (60 วัน) | เส้น | `request_backlog_daily` |
| คำขอค้างตามทีม × อายุ · คำขอค้างนานสุด | ตาราง | `open_requests` |

## Dashboard 7 — ผู้บริหาร · ภาพรวมรายสัปดาห์ (CD-92)

แดชบอร์ดที่ผู้บริหารเปิดแทนการรวบรวมรายงานรายสัปดาห์ด้วยมือ — อ่าน `mart` อย่างเดียว
และ **ล็อกบริษัทได้** (ด้านล่าง). ตาราง mart ที่ CD-92 เพิ่ม:

| ตาราง | หนึ่งแถวคือ | ใช้ตอบ |
|---|---|---|
| `mart.fact_leads` | Lead 1 ใบ · แหล่งที่มา แคมเปญ มาจากบริษัทเป้าหมายไหม แปลงเป็นดีลไหม กี่วัน ติดต่อกี่ครั้ง (นิยามการติดต่อเดียวกับ CD-85) | Getter: Lead → ดีล, แหล่งที่มาไหนได้ผล |
| `mart.fact_deals` | ดีล 1 ดีล ทั้งเปิดและปิด · ชนิดดีล (CD-86) วันที่ปิด เหตุผลที่แพ้ | Win rate, ขายเพิ่ม/ขายข้าม/ต่ออายุ |
| `mart.customer_accounts` | ลูกค้าที่ active 1 ราย · ระดับ รอบทบทวน ติดต่อล่าสุด **สุขภาพ** + สัญญาณ | Keeper: ลูกค้าเสี่ยง, แผนบัญชี |
| `mart.customer_health_daily` | วัน × บริษัท × สุขภาพ | แนวโน้มสุขภาพลูกค้า (แถววันนี้เขียนทับทุกรอบ) |

สุขภาพลูกค้าใน mart **คำนวณโดย `KeeperService` ตัวเดียวกับหน้า Portfolio** (core-service เขียนแถวให้
ในรอบ rebuild) ไม่ได้เขียนกติกาซ้ำใน SQL — สีบนแดชบอร์ดกับสีที่เจ้าของบัญชีเห็นจึงตรงกันเสมอ

| การ์ด | อ่านจาก |
|---|---|
| ข้อมูล ณ · ยอดขายสัปดาห์นี้ · Win rate 90 วัน · Pipeline ถ่วงน้ำหนัก · ลูกค้าใหม่เดือนนี้ | `refresh_log`, `fact_sales`, `fact_deals`, `fact_pipeline` |
| ยอดขายเดือนนี้เทียบเดือนก่อน · คำขอเกินกำหนดตอนนี้ · ลูกค้าเสี่ยง | `fact_sales`, `open_requests`, `customer_accounts` |
| Getter · Lead → ดีล รายเดือน · แหล่งที่มาของ Lead | `fact_leads` |
| Win rate ตามชนิดดีล · เหตุผลที่แพ้ | `fact_deals` |
| Keeper · สุขภาพตอนนี้ · แนวโน้ม 30 วัน · แผนบัญชีและรอบทบทวน · ยอดขายตามชนิดดีล · ลูกค้าที่ต้องดูแล | `customer_accounts`, `customer_health_daily`, `fact_sales` + `fact_deals` |

**สร้าง:** `python3 infra/metabase/build_exec_dashboard.py` (ดู docstring) — script รันทุกการ์ดหนึ่งครั้ง
หลังสร้าง และหยุดทันทีถ้าการ์ดไหน error จึงไม่มีแดชบอร์ดที่มีการ์ดพังหลุดออกไป.
แล้วเพิ่มเลข dashboard ที่หน้า ตั้งค่า BI โดย **เปิด "กรองตามบริษัทของผู้ดู"**

### ล็อกบริษัท (CD-92)

ทุกการ์ดในแดชบอร์ดนี้มีเงื่อนไข `[[AND company_code = {{company}}]]` และแดชบอร์ดมีตัวแปร `company`
ที่ตั้ง embedding เป็น **locked**. เมื่อแถวใน `bi_dashboards` มี `lockCompany = true` ระบบเซ็น
token ด้วย `params: { company: <รหัสบริษัทที่ผู้ดูเลือกอยู่> }` — ผู้ดูเห็นเฉพาะบริษัทตัวเอง
เปลี่ยนค่าเองไม่ได้ (Metabase ตอบ 400 เมื่อพยายามส่ง `?company=` เอง และปฏิเสธ token ที่ไม่มีค่า).
เปิดใน Metabase เองโดยแอดมิน ตัวกรองว่าง = เห็นทุกบริษัท.

แดชบอร์ดเก่าที่ **ไม่มี** ตัวแปร `company` ต้องปิดสวิตช์นี้ไว้ (ค่าเริ่มต้น) ไม่งั้น Metabase ปฏิเสธ token.
แดชบอร์ด 6 (CD-91) ยังไม่มีตัวแปรนี้ — ถ้าจะแยกบริษัทให้เพิ่มแบบเดียวกัน.

## ฝังเข้าเมนูของระบบ (ใช้ login ของระบบ ไม่ต้อง login Metabase ซ้ำ)

ระบบเสิร์ฟเมนู BI ที่ `GET /bi/menu` (core-service) ตามหลัก ROLE-06 — เมนูประกอบจาก permission:

- `report.dashboard.read` → เห็นรายการแดชบอร์ดพร้อม **embed URL แบบ signed อายุ 10 นาที** เอาไปใส่ `<iframe>` ได้เลย (seed ให้ role ผู้จัดการฝ่าย / ผู้บริหาร / ผู้ตรวจสอบ)
- `admin.bi.manage` → ได้ `settings_url` ลิงก์เข้า Metabase สำหรับตั้งค่า (seed ให้ role ผู้ดูแลระบบ)

ตั้งค่าครั้งเดียว:

1. Metabase: Admin → Settings → **Embedding** → เปิด Static embedding แล้วคัดลอก secret key
2. เปิด embedding รายแดชบอร์ด: หน้า dashboard → Sharing → Embed → Publish (ทั้ง 3 ชุด)
3. เติมใน `.env` ของ backend: `METABASE_SITE_URL`, `METABASE_EMBED_SECRET`, `METABASE_DASHBOARD_REQUEST/APPROVAL/SLA` (เลข id จาก URL ของแดชบอร์ด)

การควบคุมสิทธิ์อยู่ที่ระบบเราทั้งหมด: PolicyGuard ตัดสินก่อน แล้วค่อยเซ็น token — token หมดอายุเองใน 10 นาที และผู้ใช้ทั่วไปไม่มีบัญชี Metabase เลย

## บน server 192.168.31.51 (deploy แล้ว 26 ส.ค. 2026)

- รันอยู่ที่ `~/metabase/` ด้วย compose ตัวเดียวกันนี้ · **port 3400** (3300 บน server เป็นของ Loki) → http://192.168.31.51:3400
- `~/metabase/.env` มี `METABASE_PORT=3400` + `METABASE_APP_DB_PASSWORD`
- ตั้งค่าเริ่มต้นแล้ว: บัญชีแอดมิน, เปิด static embedding, generate secret แล้ว
- ยังไม่ได้ต่อ database ของระบบ (CTD ยังไม่ deploy) — เมื่อ database จริงพร้อม: รัน `reporting.sql` ใส่มัน → Admin → Databases → เพิ่ม connection ด้วย `metabase_ro` → สร้างแดชบอร์ดซ้ำด้วย `python3 infra/metabase/build_dashboards.py` (ดู docstring) → เอา dashboard ids + secret ไปใส่ `.env` ของ core-service

## กติกา

- **ห้ามต่อ Metabase ด้วย role อื่นนอกจาก `metabase_ro`** และห้าม grant อะไรเพิ่มให้ role นี้นอก schema `reporting` และ `mart`
- อยากได้ field ใหม่ในแดชบอร์ด → แก้ view ใน `reporting.sql` แล้วรัน psql ซ้ำ (idempotent) — ไม่เปิดตารางจริงเด็ดขาด
- สิทธิ์การเห็นแดชบอร์ดจัดที่ Metabase groups (path นี้คือ BI ระดับบริหารตาม CD-92 ไม่มี row-level scope) — ระบบหลักยังบังคับ scope ที่ backend ตามเดิม ห้ามเอา view เหล่านี้ไปเสิร์ฟกลับเข้าแอป
