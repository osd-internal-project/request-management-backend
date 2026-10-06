-- CD-266 (CD-22 KBMS) — the knowledge base in the Data Mart (`mart`, which
-- Metabase reads), rebuilt with DataMartService. Counts only, no text.
-- Idempotent (IF NOT EXISTS), like 20260929220000_data_mart.
CREATE SCHEMA IF NOT EXISTS mart;

-- AI channels (CD-265) per Bangkok month and channel.
CREATE TABLE IF NOT EXISTS mart.fact_kb_ai_monthly (
  company_code     TEXT NOT NULL,
  month            TEXT NOT NULL,          -- YYYY-MM (Bangkok)
  channel          TEXT NOT NULL,          -- ai_care · ai_smart
  searches         INT NOT NULL,
  answered         INT NOT NULL,
  unanswered       INT NOT NULL,
  pending          INT NOT NULL,           -- no outcome reported
  self_answer_pct  NUMERIC(5, 1),          -- answered ÷ (answered + unanswered)
  PRIMARY KEY (company_code, month, channel)
);

-- Knowledge gaps (CD-266) opened and closed per month and kind; a staff
-- search miss counts once it has repeated 3 times (the standard).
CREATE TABLE IF NOT EXISTS mart.fact_kb_gaps_monthly (
  company_code  TEXT NOT NULL,
  month         TEXT NOT NULL,
  kind          TEXT NOT NULL,             -- ai_unanswered · low_rated · search_miss
  opened        INT NOT NULL,
  resolved      INT NOT NULL,
  dismissed     INT NOT NULL,
  PRIMARY KEY (company_code, month, kind)
);
