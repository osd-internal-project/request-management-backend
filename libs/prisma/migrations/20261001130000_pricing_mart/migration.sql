-- CD-208 — วิเคราะห์ราคาและกำไร: the pricing mart, rebuilt with the Data Mart
-- (DataMartService, hourly).
--
-- Its own schema, apart from `mart`: these tables carry margins, costs and
-- discounts, which `mart` deliberately leaves out because Metabase's
-- `metabase_ro` reads all of it (SCOPE-04). `mart_pricing` is read by the app
-- (pricing.price.read) and, only if a DBA grants it, by a separate
-- `metabase_pricing_ro` role — see infra/metabase/reporting.sql.
--
-- Idempotent (IF NOT EXISTS throughout), like 20260929220000_data_mart:
-- Prisma resets only `public` in the shadow database.
CREATE SCHEMA IF NOT EXISTS mart_pricing;

-- One row per line of a quotation version that went past approval
-- (approved, sent, accepted, declined) — superseded, cancelled, drafts and
-- versions still waiting are left out.
CREATE TABLE IF NOT EXISTS mart_pricing.fact_quotation_lines (
  quotation_id      TEXT NOT NULL,
  line_no           INTEGER NOT NULL,
  quotation_no      TEXT NOT NULL,
  version           INTEGER NOT NULL,
  company_code      TEXT NOT NULL,
  status            TEXT NOT NULL,
  is_accepted       BOOLEAN NOT NULL,
  approved_on       DATE,                   -- Bangkok date
  approved_month    TEXT,                   -- YYYY-MM, Bangkok
  currency          TEXT NOT NULL,
  customer_code     TEXT,
  customer_name     TEXT NOT NULL,          -- the customer, or the prospect
  opportunity_code  TEXT,
  owner_user_id     TEXT NOT NULL,
  owner_name        TEXT,
  owner_unit        TEXT,
  product_code      TEXT,
  product_group     TEXT,
  work_type         TEXT,
  price_model       TEXT NOT NULL,
  gross             NUMERIC(14, 2) NOT NULL,  -- before the line's discount
  discount_pct      NUMERIC(7, 2) NOT NULL,
  discount_amount   NUMERIC(14, 2) NOT NULL,
  net               NUMERIC(14, 2) NOT NULL,
  cost              NUMERIC(14, 2) NOT NULL,
  margin            NUMERIC(14, 2) NOT NULL,
  cost_source       TEXT,
  vendor_name       TEXT,                   -- who the cost came from, when known
  price_overridden  BOOLEAN NOT NULL,
  system_price      NUMERIC(14, 2),
  PRIMARY KEY (quotation_id, line_no)
);
CREATE INDEX IF NOT EXISTS fact_quotation_lines_month_idx
  ON mart_pricing.fact_quotation_lines (company_code, approved_month);

-- The pricing exception register (CD-205), superseded rows left out.
CREATE TABLE IF NOT EXISTS mart_pricing.fact_pricing_exceptions (
  exception_id      TEXT PRIMARY KEY,
  company_code      TEXT NOT NULL,
  kind              TEXT NOT NULL,
  decision          TEXT NOT NULL,
  recorded_on       DATE NOT NULL,          -- Bangkok date
  recorded_month    TEXT NOT NULL,          -- YYYY-MM, Bangkok
  quotation_no      TEXT NOT NULL,
  version           INTEGER NOT NULL,
  customer_name     TEXT NOT NULL,
  work_type         TEXT,
  product_code      TEXT,
  net_total         NUMERIC(14, 2) NOT NULL
);
CREATE INDEX IF NOT EXISTS fact_pricing_exceptions_month_idx
  ON mart_pricing.fact_pricing_exceptions (company_code, recorded_month);
