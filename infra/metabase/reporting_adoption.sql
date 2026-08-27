-- CD-92 — reporting views for the two adoption dashboards, over the workshop
-- schema (see workshop_schema.sql / workshop_seed.sql).
--
-- Run against the application database AFTER the workshop schema + seed and
-- AFTER reporting.sql (which creates the `reporting` schema and metabase_ro):
--     psql "$DATABASE_URL" -f infra/metabase/reporting_adoption.sql
--
-- These views are OWNED by the app role, so metabase_ro reads them without any
-- grant on the workshop tables themselves — the read-only BI role never
-- touches base tables, exactly as with the operational reporting views.
--
-- The cut-off date the dashboards report "as of" is centralised here; change
-- the one CTE if the workshop snapshot date moves.

\set ON_ERROR_STOP on

CREATE SCHEMA IF NOT EXISTS reporting;

-- The single source of "now" for these snapshot dashboards. The workshop data
-- is a fixed extract as of 24 ส.ค. 2569, so overdue / due-soon are measured
-- against that date, not wall-clock now().
CREATE OR REPLACE VIEW reporting.adoption_asof AS
  SELECT DATE '2026-08-24' AS as_of;

-- --- per-team summary (image 1 left table + executive cards 2 & 3) ----------
-- One row per team, whether or not it has opened a request. `opened`,
-- `received`, `action_logs`, `closed` are the four headline columns; the derived
-- flags drive the "used vs not-yet" split and the participation note.

CREATE OR REPLACE VIEW reporting.adoption_teams AS
WITH opened AS (
  SELECT requester_dept_code AS dept, count(*) AS n,
         count(*) FILTER (WHERE status IN ('COMPLETED','CLOSED')) AS closed
  FROM workshop.request GROUP BY 1
),
received AS (
  SELECT assignee_dept_code AS dept, count(*) AS n
  FROM workshop.request WHERE assignee_dept_code IS NOT NULL GROUP BY 1
),
logs AS (
  SELECT actor_dept_code AS dept, count(*) AS n
  FROM workshop.action_log GROUP BY 1
),
total AS (SELECT count(*)::numeric AS n FROM workshop.request)
SELECT
  d.dept_code,
  d.name_th,
  d.sort_order,
  d.has_log_file,
  COALESCE(o.n, 0)                                   AS opened,
  ROUND(100.0 * COALESCE(o.n, 0) / NULLIF((SELECT n FROM total), 0), 1) AS opened_pct,
  COALESCE(r.n, 0)                                   AS received,
  COALESCE(l.n, 0)                                   AS action_logs,
  COALESCE(o.closed, 0)                              AS closed,
  (COALESCE(o.n, 0) > 0)                             AS has_opened,
  CASE
    WHEN COALESCE(o.n, 0) > 40 THEN 'สูงมาก'
    WHEN COALESCE(o.n, 0) >= 5 THEN 'ปานกลาง'
    WHEN COALESCE(o.n, 0) > 0 THEN 'เริ่มต้น'
    ELSE '—'
  END                                               AS usage_level,
  -- The "สถานะการมีส่วนร่วม" sentence for teams that have not opened yet.
  CASE
    WHEN COALESCE(o.n, 0) > 0 THEN NULL
    WHEN NOT d.has_log_file THEN 'ยังไม่มีไฟล์ Request Log ในโฟลเดอร์'
    WHEN COALESCE(r.n, 0) > 0
      THEN 'ยังไม่เปิดคำขอ · ถูกขอให้ทำงานแล้ว ' || r.n
           || ' รายการ แต่ยังไม่บันทึกการดำเนินการ'
    ELSE 'ยังไม่มีความเคลื่อนไหวในระบบ'
  END                                               AS participation_note
FROM workshop.department d
LEFT JOIN opened   o ON o.dept = d.dept_code
LEFT JOIN received r ON r.dept = d.dept_code
LEFT JOIN logs     l ON l.dept = d.dept_code;

-- --- request-level detail (executive summary cards 1, 5, 6) -----------------
-- One row per request with the derived timing flags both dashboards need.

CREATE OR REPLACE VIEW reporting.adoption_requests AS
SELECT
  r.request_id,
  r.requester_dept_code,
  r.assignee_dept_code,
  r.assignee_emp_code,
  s.full_name                              AS assignee_name,
  r.subject,
  COALESCE(r.status, 'ไม่ระบุ')            AS status,
  r.status                                 AS status_raw,
  r.submitted_at,
  r.due_at,
  r.closed_at,
  (r.status IN ('COMPLETED','CLOSED'))     AS is_terminal,
  (r.assignee_dept_code IS NOT NULL
     AND r.assignee_dept_code <> r.requester_dept_code) AS is_cross_dept,
  (r.status NOT IN ('COMPLETED','CLOSED') OR r.status IS NULL) AS is_open,
  CASE
    WHEN r.status IN ('COMPLETED','CLOSED') THEN NULL
    WHEN r.due_at IS NULL THEN NULL
    WHEN r.due_at < (SELECT as_of FROM reporting.adoption_asof) THEN 'overdue'
    WHEN r.due_at = (SELECT as_of FROM reporting.adoption_asof) THEN 'due_today'
    WHEN r.due_at <= (SELECT as_of FROM reporting.adoption_asof) + 3 THEN 'due_soon'
    ELSE 'later'
  END                                      AS due_bucket
FROM workshop.request r
LEFT JOIN workshop.staff s ON s.employee_code = r.assignee_emp_code;

-- --- inter-department flow (executive summary card 4) -----------------------
-- One row per (opener, receiver) pair with a count — the cross-department
-- hand-offs, ready for a matrix or a ranked list.

CREATE OR REPLACE VIEW reporting.adoption_flow AS
SELECT
  requester_dept_code AS from_dept,
  assignee_dept_code  AS to_dept,
  count(*)            AS requests
FROM workshop.request
WHERE assignee_dept_code IS NOT NULL
  AND assignee_dept_code <> requester_dept_code
GROUP BY 1, 2;

-- --- overall status split (executive summary donut, card 1) -----------------

CREATE OR REPLACE VIEW reporting.adoption_status AS
SELECT
  CASE COALESCE(status, '')
    WHEN 'IN_PROGRESS'      THEN 'กำลังดำเนินการ'
    WHEN 'COMPLETED'        THEN 'ดำเนินการเสร็จ'
    WHEN ''                 THEN 'ไม่ระบุสถานะ'
    WHEN 'SUBMITTED'        THEN 'ส่งคำขอแล้ว'
    WHEN 'CLOSED'           THEN 'ปิดงานแล้ว'
    WHEN 'PENDING_APPROVAL' THEN 'รออนุมัติ'
    ELSE COALESCE(status, 'ไม่ระบุสถานะ')
  END                       AS status_label,
  count(*)                  AS requests
FROM workshop.request
GROUP BY 1;

-- --- grants -----------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'metabase_ro') THEN
    GRANT USAGE ON SCHEMA reporting TO metabase_ro;
    GRANT SELECT ON
      reporting.adoption_asof,
      reporting.adoption_teams,
      reporting.adoption_requests,
      reporting.adoption_flow,
      reporting.adoption_status
    TO metabase_ro;
  END IF;
END $$;
