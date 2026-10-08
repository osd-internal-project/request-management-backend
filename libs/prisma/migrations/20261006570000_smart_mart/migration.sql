-- CD-295 (CD-16 AI SMART) — the sweep-to-sale funnel in the Data Mart
-- (`mart` schema, rebuilt hourly by core-service with the rest of the mart).
-- Each prospect counted once, at the furthest stage it reached. Not Prisma
-- models: the app and Metabase read them raw.

-- One row per swept business.
CREATE TABLE IF NOT EXISTS mart.fact_smart_prospects (
  prospect_id    TEXT PRIMARY KEY,
  company_code   TEXT NOT NULL,
  source_id      TEXT NOT NULL,
  source_code    TEXT NOT NULL,
  source_name    TEXT NOT NULL,
  source_kind    TEXT NOT NULL,
  sales_axis     TEXT,
  call_list_id   TEXT,
  call_list_name TEXT,
  swept_month    TEXT NOT NULL,          -- YYYY-MM, Bangkok
  status         TEXT NOT NULL,
  score          INTEGER,
  match_kind     TEXT,
  screened       BOOLEAN NOT NULL,
  called         BOOLEAN NOT NULL,
  reached        BOOLEAN NOT NULL,
  refused        BOOLEAN NOT NULL,
  interested     BOOLEAN NOT NULL,
  handed_off     BOOLEAN NOT NULL,
  deal           BOOLEAN NOT NULL,
  won            BOOLEAN NOT NULL,
  calls          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS fact_smart_prospects_company_idx
  ON mart.fact_smart_prospects (company_code, swept_month);

-- One row per AI call.
CREATE TABLE IF NOT EXISTS mart.fact_smart_calls (
  call_id      TEXT PRIMARY KEY,
  company_code TEXT NOT NULL,
  list_id      TEXT NOT NULL,
  list_name    TEXT NOT NULL,
  source_code  TEXT NOT NULL,
  sales_axis   TEXT,
  month        TEXT NOT NULL,            -- YYYY-MM, Bangkok
  status       TEXT NOT NULL,
  outcome      TEXT,
  duration_sec INTEGER,
  reached      BOOLEAN NOT NULL
);
CREATE INDEX IF NOT EXISTS fact_smart_calls_company_idx
  ON mart.fact_smart_calls (company_code, month);
