-- CD-234 — ต้นทุนแรงงาน: one row per approved timesheet line, priced with
-- the cost rate of the person's level × the line's work type in effect on
-- the day worked (CD-207). Rebuilt with the Data Mart (DataMartService).
--
-- In `mart_pricing`, not `mart`: costs are pay-derived and Metabase's
-- `metabase_ro` must not read them (SCOPE-04, CD-208).
--
-- Idempotent (IF NOT EXISTS), like 20261001130000_pricing_mart.
CREATE SCHEMA IF NOT EXISTS mart_pricing;

CREATE TABLE IF NOT EXISTS mart_pricing.fact_labor_costs (
  line_id           TEXT PRIMARY KEY,
  company_code      TEXT NOT NULL,
  work_date         DATE NOT NULL,
  work_month        TEXT NOT NULL,          -- YYYY-MM
  kind              TEXT NOT NULL,          -- project · service · presales · internal
  project_no        TEXT,
  request_no        TEXT,
  request_type      TEXT,
  solution_id       TEXT,
  internal_code     TEXT,
  user_id           TEXT NOT NULL,
  user_name         TEXT,
  level_code        TEXT,                   -- the person's level now (null = none)
  work_type_code    TEXT NOT NULL,
  hours             NUMERIC(6, 1) NOT NULL,
  billable          BOOLEAN NOT NULL,
  cost_per_manday   NUMERIC(14, 2),         -- null = no rate that day
  cost              NUMERIC(14, 2)          -- null = unpriced
);
CREATE INDEX IF NOT EXISTS fact_labor_costs_month_idx
  ON mart_pricing.fact_labor_costs (company_code, work_month, kind);
