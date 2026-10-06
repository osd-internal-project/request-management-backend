-- CD-274 (CD-15 MACOM) — campaign results to real revenue, in the Data Mart
-- (`mart` schema, rebuilt hourly by core-service with the rest of the mart).
-- Credit goes to the Lead's campaign (first touch): its deals' sale orders
-- (booked) and their contracts' installments (invoiced, paid), against the
-- campaign's actual spend (CD-268). Not Prisma models: the app reads them raw.

-- One row per campaign — totals since it started.
CREATE TABLE IF NOT EXISTS mart.fact_campaigns (
  campaign_id        TEXT PRIMARY KEY,
  company_code       TEXT NOT NULL,
  company_name       TEXT NOT NULL,
  campaign_code      TEXT NOT NULL,
  campaign_name      TEXT NOT NULL,
  kind               TEXT NOT NULL,
  sales_axis         TEXT,
  channel            TEXT,
  start_date         DATE,
  end_date           DATE,
  active             BOOLEAN NOT NULL,
  budget             NUMERIC(14, 2),
  spent              NUMERIC(14, 2) NOT NULL,
  leads              INTEGER NOT NULL,
  converted          INTEGER NOT NULL,
  won_deals          INTEGER NOT NULL,
  booked             NUMERIC(14, 2) NOT NULL,
  invoiced           NUMERIC(14, 2) NOT NULL,
  paid               NUMERIC(14, 2) NOT NULL,
  cost_per_lead      NUMERIC(14, 2),
  cost_per_won_deal  NUMERIC(14, 2),
  roi_paid           NUMERIC(14, 2),
  roi_booked         NUMERIC(14, 2)
);
CREATE INDEX IF NOT EXISTS fact_campaigns_company_idx ON mart.fact_campaigns (company_code);

-- One row per campaign and Bangkok month something happened in it.
CREATE TABLE IF NOT EXISTS mart.fact_campaign_monthly (
  campaign_id   TEXT NOT NULL,
  company_code  TEXT NOT NULL,
  campaign_code TEXT NOT NULL,
  month         TEXT NOT NULL,          -- YYYY-MM, Bangkok
  spent         NUMERIC(14, 2) NOT NULL,
  leads         INTEGER NOT NULL,
  won_deals     INTEGER NOT NULL,
  booked        NUMERIC(14, 2) NOT NULL,
  invoiced      NUMERIC(14, 2) NOT NULL,
  paid          NUMERIC(14, 2) NOT NULL,
  PRIMARY KEY (campaign_id, month)
);
CREATE INDEX IF NOT EXISTS fact_campaign_monthly_company_idx ON mart.fact_campaign_monthly (company_code, month);
