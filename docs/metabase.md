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

- **ห้ามต่อ Metabase ด้วย role อื่นนอกจาก `metabase_ro`** และห้าม grant อะไรเพิ่มให้ role นี้นอก schema `reporting`
- อยากได้ field ใหม่ในแดชบอร์ด → แก้ view ใน `reporting.sql` แล้วรัน psql ซ้ำ (idempotent) — ไม่เปิดตารางจริงเด็ดขาด
- สิทธิ์การเห็นแดชบอร์ดจัดที่ Metabase groups (path นี้คือ BI ระดับบริหารตาม CD-92 ไม่มี row-level scope) — ระบบหลักยังบังคับ scope ที่ backend ตามเดิม ห้ามเอา view เหล่านี้ไปเสิร์ฟกลับเข้าแอป
