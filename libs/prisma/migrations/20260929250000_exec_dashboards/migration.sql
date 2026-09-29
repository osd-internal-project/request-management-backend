-- CD-92 — แดชบอร์ดผู้บริหารชุดแรก: เพิ่ม Data Mart ของแกนขาย (Getter / Keeper)
-- และ win rate, กับการล็อกบริษัทตอนฝังแดชบอร์ด.

-- A dashboard over the mart may be locked to the viewer's company.
ALTER TABLE "bi_dashboards" ADD COLUMN IF NOT EXISTS "lockCompany" BOOLEAN NOT NULL DEFAULT false;

-- Idempotent throughout, as 20260929220000_data_mart: Prisma resets only
-- `public` in the shadow database.
CREATE SCHEMA IF NOT EXISTS mart;

-- One row per lead — Getter: where leads come from and how many become deals.
CREATE TABLE IF NOT EXISTS mart.fact_leads (
  lead_id           TEXT PRIMARY KEY,
  company_code      TEXT NOT NULL,
  created_on        DATE NOT NULL,          -- Bangkok date
  created_month     TEXT NOT NULL,          -- YYYY-MM, Bangkok
  source_code       TEXT,
  campaign_code     TEXT,
  from_target       BOOLEAN NOT NULL,       -- came from a target account (CD-85)
  status            TEXT NOT NULL,
  status_kind       TEXT NOT NULL,          -- open / won / lost
  is_converted      BOOLEAN NOT NULL,
  converted_on      DATE,
  days_to_convert   INTEGER,
  contact_attempts  INTEGER NOT NULL,       -- completed contacts (CD-85)
  owner_name        TEXT,
  owner_unit        TEXT
);
CREATE INDEX IF NOT EXISTS fact_leads_month_idx ON mart.fact_leads (company_code, created_month);

-- One row per deal, open or closed — win rate, deal types (CD-86).
CREATE TABLE IF NOT EXISTS mart.fact_deals (
  opportunity_id    TEXT PRIMARY KEY,
  opportunity_code  TEXT NOT NULL,
  company_code      TEXT NOT NULL,
  deal_type         TEXT NOT NULL,          -- new_business / upsell / cross_sell / renewal
  stage             TEXT NOT NULL,
  is_open           BOOLEAN NOT NULL,
  is_won            BOOLEAN NOT NULL,
  is_lost           BOOLEAN NOT NULL,
  amount            NUMERIC(14, 2),
  created_on        DATE NOT NULL,
  created_month     TEXT NOT NULL,
  closed_on         DATE,                   -- won or lost, Bangkok
  closed_month      TEXT,
  lost_reason       TEXT,
  customer_code     TEXT,                   -- null = a prospect
  from_lead         BOOLEAN NOT NULL,
  owner_name        TEXT,
  owner_unit        TEXT
);
CREATE INDEX IF NOT EXISTS fact_deals_closed_idx ON mart.fact_deals (company_code, closed_month);

-- One row per active customer — Keeper: plan, reviews, health. Health is the
-- application's (KeeperService), written by core-service, not re-derived here.
CREATE TABLE IF NOT EXISTS mart.customer_accounts (
  customer_id        TEXT PRIMARY KEY,
  company_code       TEXT NOT NULL,
  customer_code      TEXT NOT NULL,
  customer_name      TEXT NOT NULL,
  owner_name         TEXT,
  tier               TEXT,                  -- a / b / c, null = no plan
  next_review_on     DATE,
  review_overdue     BOOLEAN NOT NULL,
  last_contact_on    DATE,
  days_since_contact INTEGER,
  last_satisfaction  INTEGER,
  health             TEXT NOT NULL,         -- green / amber / red
  signals            TEXT NOT NULL,         -- signal codes, comma-separated
  open_deals         INTEGER,
  open_expansion     INTEGER,
  revenue_12m        NUMERIC(14, 2),
  target_revenue     NUMERIC(14, 2)
);
CREATE INDEX IF NOT EXISTS customer_accounts_company_idx ON mart.customer_accounts (company_code, health);

-- Health counts per day — the Keeper trend. Today's rows are rewritten each
-- rebuild; earlier days are left as they were.
CREATE TABLE IF NOT EXISTS mart.customer_health_daily (
  snapshot_date  DATE NOT NULL,
  company_code   TEXT NOT NULL,
  health         TEXT NOT NULL,
  accounts       INTEGER NOT NULL,
  PRIMARY KEY (snapshot_date, company_code, health)
);
