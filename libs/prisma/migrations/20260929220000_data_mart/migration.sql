-- CD-91 — Data Mart: sales and open requests, rebuilt by core-service
-- (DataMartService, hourly) so executives read one prepared place instead of
-- figures gathered by hand.
--
-- Its own schema, outside Prisma's datamodel (the datasource is pinned to
-- `public`), so `prisma migrate diff` never sees these tables. Plain tables,
-- not views: a view over `public` would make every later migration that
-- alters a column it reads fail. The rebuild SQL lives with the service.
--
-- No form contents (`formData`, margins, discounts) anywhere — SCOPE-04, as
-- in the `reporting` schema. Metabase reads it through `metabase_ro`; the
-- grants are in infra/metabase/reporting.sql, which creates that role.

-- Idempotent (IF NOT EXISTS throughout): Prisma resets only `public` in the
-- shadow database, so a `mart` left there by an earlier `migrate diff` must
-- not make this migration fail on the next one.
CREATE SCHEMA IF NOT EXISTS mart;

-- When each table was last rebuilt, and how big it came out.
CREATE TABLE IF NOT EXISTS mart.refresh_log (
  table_name   TEXT PRIMARY KEY,
  refreshed_at TIMESTAMPTZ NOT NULL,
  row_count    INTEGER NOT NULL,
  duration_ms  INTEGER NOT NULL
);

-- One row per sale order (cancelled ones kept, flagged) — ยอดขาย.
CREATE TABLE IF NOT EXISTS mart.fact_sales (
  sale_order_id     TEXT PRIMARY KEY,
  sale_order_code   TEXT NOT NULL,
  company_code      TEXT NOT NULL,
  company_name      TEXT NOT NULL,
  ordered_at        TIMESTAMPTZ NOT NULL,
  ordered_on        DATE NOT NULL,          -- Bangkok date
  order_month       TEXT NOT NULL,          -- YYYY-MM, Bangkok
  status            TEXT NOT NULL,
  is_cancelled      BOOLEAN NOT NULL,
  amount            NUMERIC(14, 2),
  currency          TEXT NOT NULL,
  customer_code     TEXT,
  customer_name     TEXT,
  customer_type     TEXT,
  opportunity_code  TEXT,
  owner_user_id     TEXT NOT NULL,
  owner_name        TEXT,
  owner_unit_id     TEXT,
  owner_unit        TEXT,
  erp_status        TEXT
);
CREATE INDEX IF NOT EXISTS fact_sales_month_idx ON mart.fact_sales (company_code, order_month);

-- One row per open deal — pipeline.
CREATE TABLE IF NOT EXISTS mart.fact_pipeline (
  opportunity_id     TEXT PRIMARY KEY,
  opportunity_code   TEXT NOT NULL,
  title              TEXT NOT NULL,
  company_code       TEXT NOT NULL,
  company_name       TEXT NOT NULL,
  stage              TEXT NOT NULL,
  amount             NUMERIC(14, 2),
  currency           TEXT NOT NULL,
  probability        INTEGER,
  weighted_amount    NUMERIC(16, 2) NOT NULL,
  expected_close_on  DATE,
  expected_close_month TEXT,
  party_name         TEXT,
  is_prospect        BOOLEAN NOT NULL,
  owner_user_id      TEXT NOT NULL,
  owner_name         TEXT,
  owner_unit_id      TEXT,
  owner_unit         TEXT,
  created_on         DATE NOT NULL,
  age_days           INTEGER NOT NULL,
  last_activity_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS fact_pipeline_close_idx ON mart.fact_pipeline (company_code, expected_close_month);

-- One row per sales target (CD-82) with what was sold against it.
CREATE TABLE IF NOT EXISTS mart.sales_target_actual (
  target_id          TEXT PRIMARY KEY,
  company_code       TEXT NOT NULL,
  period             TEXT NOT NULL,          -- YYYY-MM, Bangkok
  scope              TEXT NOT NULL,          -- user | org_unit
  subject_id         TEXT NOT NULL,
  subject_name       TEXT,
  target_amount      NUMERIC(14, 2) NOT NULL,
  actual_amount      NUMERIC(16, 2) NOT NULL,
  pipeline_weighted  NUMERIC(16, 2) NOT NULL,
  forecast_amount    NUMERIC(16, 2) NOT NULL,
  attainment_pct     NUMERIC(6, 1),
  forecast_pct       NUMERIC(6, 1),
  is_closed          BOOLEAN NOT NULL
);
CREATE INDEX IF NOT EXISTS sales_target_actual_period_idx ON mart.sales_target_actual (company_code, period);

-- One row per request not yet finished — คำขอค้าง, as of the last rebuild.
CREATE TABLE IF NOT EXISTS mart.open_requests (
  request_id         TEXT PRIMARY KEY,
  request_no         TEXT,
  company_code       TEXT NOT NULL,
  company_name       TEXT NOT NULL,
  type_code          TEXT NOT NULL,
  type_name          TEXT NOT NULL,
  status             TEXT NOT NULL,
  receiver_unit_id   TEXT,
  receiver_unit      TEXT,
  assignee           TEXT,
  requester          TEXT,
  requester_unit     TEXT,
  submitted_at       TIMESTAMPTZ,
  due_at             TIMESTAMPTZ,
  age_days           INTEGER NOT NULL,
  age_bucket         TEXT NOT NULL,
  sla_status         TEXT
);
CREATE INDEX IF NOT EXISTS open_requests_unit_idx ON mart.open_requests (company_code, receiver_unit_id);

-- One row per Bangkok day × company × team × type × status. Today's rows are
-- rewritten on every rebuild; earlier days are never touched again, which is
-- what lets the backlog be read as a trend.
CREATE TABLE IF NOT EXISTS mart.request_backlog_daily (
  snapshot_date      DATE NOT NULL,
  company_code       TEXT NOT NULL,
  receiver_unit      TEXT NOT NULL,          -- '-' when the type names no team
  type_code          TEXT NOT NULL,
  type_name          TEXT NOT NULL,
  status             TEXT NOT NULL,
  open_count         INTEGER NOT NULL,
  overdue_count      INTEGER NOT NULL,
  avg_age_days       NUMERIC(8, 1) NOT NULL,
  PRIMARY KEY (snapshot_date, company_code, receiver_unit, type_code, status)
);
