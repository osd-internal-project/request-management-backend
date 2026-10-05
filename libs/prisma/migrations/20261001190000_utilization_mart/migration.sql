-- CD-235 — Utilization: one row per person × month (the last 12 months,
-- this month to date), rebuilt with the Data Mart (DataMartService).
--
-- In `mart`, which Metabase reads: hours only — no rates and no cost (those
-- stay in `mart_pricing`, CD-234).
--
-- Idempotent (IF NOT EXISTS), like 20260929220000_data_mart.
CREATE SCHEMA IF NOT EXISTS mart;

CREATE TABLE IF NOT EXISTS mart.fact_utilization (
  company_code        TEXT NOT NULL,
  month               TEXT NOT NULL,          -- YYYY-MM (Bangkok)
  user_id             TEXT NOT NULL,
  user_name           TEXT,
  team                TEXT,                   -- the person's org unit
  level_code          TEXT,                   -- HR level now (null = none)
  level_name          TEXT,
  working_hours       NUMERIC(7, 1) NOT NULL, -- working days to date × 8
  leave_hours         NUMERIC(7, 1) NOT NULL, -- approved leave on those days
  available_hours     NUMERIC(7, 1) NOT NULL, -- working − leave
  logged_hours        NUMERIC(7, 1) NOT NULL, -- approved timesheets
  billable_hours      NUMERIC(7, 1) NOT NULL,
  project_hours       NUMERIC(7, 1) NOT NULL,
  service_hours       NUMERIC(7, 1) NOT NULL,
  presales_hours      NUMERIC(7, 1) NOT NULL,
  internal_hours      NUMERIC(7, 1) NOT NULL,
  unlogged_hours      NUMERIC(7, 1) NOT NULL, -- available not logged (≥ 0)
  utilization_pct     NUMERIC(6, 1),          -- billable ÷ available
  billable_share_pct  NUMERIC(6, 1),          -- billable ÷ logged
  PRIMARY KEY (company_code, month, user_id)
);
CREATE INDEX IF NOT EXISTS fact_utilization_month_idx
  ON mart.fact_utilization (company_code, month);
