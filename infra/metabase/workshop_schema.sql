-- OSD Request Log v1.6 — workshop adoption schema (CD-92, dashboards 4–5).
--
-- These two executive dashboards measure ADOPTION of the request system across
-- the 13 OSD teams: who opened requests, who received work, who recorded an
-- Action Log, and where requests flow between departments. They are analytics
-- over the workshop spreadsheet (sheets 01_REQUEST_LOG + 02_ACTION_LOG), NOT
-- over the live application tables — so they live in their own `workshop`
-- schema, kept apart from the app's `public` schema and from `reporting`
-- (which reads the live Prisma tables).
--
-- Run once against the application database (idempotent):
--     psql "$DATABASE_URL" -f infra/metabase/workshop_schema.sql
-- then load the sample rows with workshop_seed.sql and publish the reporting
-- views with reporting_adoption.sql.

\set ON_ERROR_STOP on

CREATE SCHEMA IF NOT EXISTS workshop;

-- --- master: the 13 teams ---------------------------------------------------
-- `participation` captures where a team stands in the rollout, so the
-- "ทีมที่ยังไม่เปิด Request" panel can distinguish a team that has been asked
-- to work (received a request) from one with no movement or no log file yet.

DROP TABLE IF EXISTS workshop.action_log CASCADE;
DROP TABLE IF EXISTS workshop.request CASCADE;
DROP TABLE IF EXISTS workshop.staff CASCADE;
DROP TABLE IF EXISTS workshop.department CASCADE;

CREATE TABLE workshop.department (
  dept_code   varchar(10) PRIMARY KEY,
  name_th     varchar(120) NOT NULL,
  name_en     varchar(120),
  sort_order  int NOT NULL DEFAULT 0,
  has_log_file boolean NOT NULL DEFAULT true,  -- PA: ยังไม่มีไฟล์ Request Log
  is_active   boolean NOT NULL DEFAULT true
);

CREATE TABLE workshop.staff (
  employee_code varchar(20) PRIMARY KEY,
  full_name     varchar(120) NOT NULL,
  dept_code     varchar(10) REFERENCES workshop.department(dept_code)
);

-- One row = one request (sheet 01_REQUEST_LOG).
--   requester_dept_code = ผู้เปิด (opener)
--   assignee_dept_code  = ผู้รับ / แผนกเจ้าของเรื่อง (receiver); NULL = ไม่ระบุ
CREATE TABLE workshop.request (
  request_id          varchar(30) PRIMARY KEY,
  requester_dept_code varchar(10) NOT NULL REFERENCES workshop.department(dept_code),
  assignee_dept_code  varchar(10) REFERENCES workshop.department(dept_code),
  assignee_emp_code   varchar(20) REFERENCES workshop.staff(employee_code),
  subject             varchar(200),
  -- v1.6 state set; NULL / '' means the recorder left สถานะ blank (ไม่ระบุสถานะ).
  status              varchar(20),
  submitted_at        date,
  due_at              date,
  closed_at           date,
  CONSTRAINT chk_ws_status CHECK (status IS NULL OR status IN (
    'DRAFT','SUBMITTED','PENDING_APPROVAL','RETURNED','APPROVED',
    'IN_PROGRESS','ON_HOLD','COMPLETED','CLOSED','REJECTED','CANCELLED'))
);

CREATE INDEX idx_ws_request_requester ON workshop.request(requester_dept_code);
CREATE INDEX idx_ws_request_assignee  ON workshop.request(assignee_dept_code);
CREATE INDEX idx_ws_request_status    ON workshop.request(status);
CREATE INDEX idx_ws_request_due       ON workshop.request(due_at);

-- One row = one recorded action (sheet 02_ACTION_LOG).
--   actor_dept_code = the team that recorded the action (บันทึกการทำงาน)
CREATE TABLE workshop.action_log (
  action_id       bigserial PRIMARY KEY,
  request_id      varchar(30) NOT NULL REFERENCES workshop.request(request_id),
  actor_dept_code varchar(10) NOT NULL REFERENCES workshop.department(dept_code),
  actor_emp_code  varchar(20) REFERENCES workshop.staff(employee_code),
  action_type     varchar(20) NOT NULL,
  occurred_at     date,
  comment         text
);

CREATE INDEX idx_ws_action_request ON workshop.action_log(request_id);
CREATE INDEX idx_ws_action_dept    ON workshop.action_log(actor_dept_code);

-- --- the 13 teams -----------------------------------------------------------

INSERT INTO workshop.department (dept_code, name_th, name_en, sort_order, has_log_file) VALUES
  ('CRM', 'ลูกค้าสัมพันธ์',       'Customer Relations',    1, true),
  ('BSD', 'สนับสนุนธุรกิจ',       'Business Support',      2, true),
  ('FAC', 'บัญชีและการเงิน',      'Finance & Accounting',  3, true),
  ('ENG', 'วิศวกรรม',            'Engineering',           4, true),
  ('BCD', 'พัฒนาธุรกิจ',         'Business Development',   5, true),
  ('PCD', 'จัดซื้อ',             'Procurement',           6, true),
  ('RND', 'วิจัยและพัฒนา',       'Research & Development', 7, true),
  ('BSC', 'บริการลูกค้า',        'Customer Service',       8, true),
  ('HRD', 'ทรัพยากรบุคคล',       'Human Resources',        9, true),
  ('LCD', 'กฎหมาย',             'Legal',                 10, true),
  ('MKT', 'การตลาด (Marcom)',    'Marketing',             11, true),
  ('PA',  'ธุรการและอาคาร',      'Premises & Admin',      12, false),
  ('PRC', 'จัดหาและประมูล',      'Procurement & Bidding', 13, true);
