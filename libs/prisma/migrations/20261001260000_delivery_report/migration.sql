-- CD-256 — รายงานการส่งมอบ.

-- When a person was last sent the overdue-installments digest
-- (`receivable.overdue`, CD-53).
CREATE TABLE "receivable_reminders" (
    "companyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,

    CONSTRAINT "receivable_reminders_pkey" PRIMARY KEY ("companyId","userId")
);

-- The Data Mart (`mart`, Metabase reads it), rebuilt with DataMartService.
-- Idempotent (IF NOT EXISTS), like 20260929220000_data_mart.
CREATE SCHEMA IF NOT EXISTS mart;

-- One row per phase (milestone, not cancelled) of every project: its
-- deliveries, its acceptance and whether that came by the milestone's due day.
CREATE TABLE IF NOT EXISTS mart.fact_delivery_phases (
  company_code        TEXT NOT NULL,
  project_id          TEXT NOT NULL,
  project_no          TEXT NOT NULL,
  project_name        TEXT NOT NULL,
  project_status      TEXT NOT NULL,
  customer_name       TEXT,
  manager_name        TEXT,
  milestone_id        TEXT NOT NULL,
  milestone_seq       INT NOT NULL,
  milestone_title     TEXT NOT NULL,
  due_on              DATE,
  deliveries          INT NOT NULL,          -- trips planned (not cancelled)
  delivered           INT NOT NULL,          -- of which delivered
  last_delivered_on   DATE,
  rounds              INT NOT NULL,          -- acceptance rounds held or booked
  phase_status        TEXT NOT NULL,         -- not_started · delivering · delivered · in_acceptance · accepted
  accepted_on         DATE,                  -- first round accepted / conditional
  accepted_month      TEXT,                  -- YYYY-MM
  result              TEXT,                  -- accepted · conditional
  first_round_passed  BOOLEAN,
  on_time             BOOLEAN,               -- accepted_on ≤ due_on (null: no due day or not accepted)
  days_late           INT,                   -- accepted: accepted_on − due_on; not yet: today − due_on (> 0 only)
  open_items          INT NOT NULL,          -- points still open from the acceptance
  certificate_signed  BOOLEAN NOT NULL,
  handover_status     TEXT,                  -- CD-255: sent · questioned · acknowledged
  PRIMARY KEY (company_code, milestone_id)
);
CREATE INDEX IF NOT EXISTS fact_delivery_phases_month_idx
  ON mart.fact_delivery_phases (company_code, accepted_month);

-- One row per installment billed (an invoice day recorded): what is owed,
-- when it falls due (invoice + credit days, as CD-193 counts it) and how late.
CREATE TABLE IF NOT EXISTS mart.fact_receivables (
  company_code        TEXT NOT NULL,
  contract_id         TEXT NOT NULL,
  contract_no         TEXT NOT NULL,
  seq                 INT NOT NULL,
  label               TEXT NOT NULL,
  kind                TEXT NOT NULL,
  project_id          TEXT,
  project_no          TEXT,
  project_name        TEXT,
  customer_name       TEXT,
  owner_user_id       TEXT NOT NULL,         -- the contract's salesperson
  owner_name          TEXT,
  amount              NUMERIC(18, 2) NOT NULL,
  invoice_no          TEXT,
  invoiced_on         DATE NOT NULL,
  invoiced_amount     NUMERIC(18, 2),
  due_on              DATE NOT NULL,         -- invoiced_on + credit days
  paid_on             DATE,
  paid_amount         NUMERIC(18, 2),
  state               TEXT NOT NULL,         -- paid · open · overdue
  days_overdue        INT,                   -- overdue only
  PRIMARY KEY (company_code, contract_id, seq)
);
CREATE INDEX IF NOT EXISTS fact_receivables_state_idx
  ON mart.fact_receivables (company_code, state);
