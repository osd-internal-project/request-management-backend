-- CD-192 — รายงานสถานะโครงการรายสัปดาห์ + เกณฑ์สุขภาพ + Data Mart ของโครงการ

-- AlterTable
ALTER TABLE "crm_company_configs" ADD COLUMN     "projectHealthAmber" INTEGER NOT NULL DEFAULT 20,
ADD COLUMN     "projectHealthRed" INTEGER NOT NULL DEFAULT 40;

-- CreateTable
CREATE TABLE "project_status_reports" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "weekStart" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "healthLevel" TEXT NOT NULL,
    "healthScore" INTEGER NOT NULL,
    "workPct" DECIMAL(5,1),
    "plannedPct" DECIMAL(5,1),
    "snapshot" JSONB NOT NULL,
    "snapshotAt" TIMESTAMP(3) NOT NULL,
    "accomplished" TEXT,
    "nextSteps" TEXT,
    "helpNeeded" TEXT,
    "submittedAt" TIMESTAMP(3),
    "submittedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "project_status_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_status_reports_companyId_weekStart_idx" ON "project_status_reports"("companyId", "weekStart");

-- CreateIndex
CREATE UNIQUE INDEX "project_status_reports_projectId_weekStart_key" ON "project_status_reports"("projectId", "weekStart");

-- AddForeignKey
ALTER TABLE "project_status_reports" ADD CONSTRAINT "project_status_reports_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Data Mart (CD-91): projects for the executive dashboard. Idempotent, as
-- 20260929220000_data_mart: Prisma resets only `public` in the shadow database.
CREATE SCHEMA IF NOT EXISTS mart;

-- One row per project — its health from the latest weekly status report.
CREATE TABLE IF NOT EXISTS mart.fact_projects (
  project_id        TEXT PRIMARY KEY,
  company_code      TEXT NOT NULL,
  project_no        TEXT NOT NULL,
  project_name      TEXT NOT NULL,
  contract_no       TEXT,
  customer_name     TEXT,
  manager_name      TEXT,
  status            TEXT NOT NULL,          -- active / on_hold / closed / cancelled
  contract_value    NUMERIC(14, 2),
  start_on          DATE,
  end_on            DATE NOT NULL,
  health            TEXT,                   -- green / amber / red; null = no report yet
  health_score      INTEGER,
  factors           TEXT,                   -- Thai labels, comma-separated
  work_pct          NUMERIC(5, 1),
  planned_pct       NUMERIC(5, 1),
  report_week       DATE,                   -- the Monday of the latest report
  report_status     TEXT,                   -- draft / submitted
  report_submitted  BOOLEAN NOT NULL
);
CREATE INDEX IF NOT EXISTS fact_projects_company_idx ON mart.fact_projects (company_code, status);

-- Projects by health, week by week, from every weekly report.
CREATE TABLE IF NOT EXISTS mart.project_health_weekly (
  week_start    DATE NOT NULL,
  company_code  TEXT NOT NULL,
  health        TEXT NOT NULL,
  projects      INTEGER NOT NULL,
  PRIMARY KEY (week_start, company_code, health)
);
