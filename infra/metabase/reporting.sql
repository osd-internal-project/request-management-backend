-- CD-10 / CD-92 — reporting layer for Metabase.
--
-- Run against the APPLICATION database (the one DATABASE_URL points at):
--
--     psql "$DATABASE_URL" -v mb_password='<strong password>' -f infra/metabase/reporting.sql
--
-- Design rules, in the spirit of the foundation spec:
--   * Metabase never touches raw tables — it sees the `reporting` schema only,
--     through the read-only `metabase_ro` role.
--   * `formData` / `payload` are NOT exposed anywhere: margin, discount and
--     other sensitive fields live inside them (SCOPE-04). Dashboards get
--     dimensions and timings, not form contents.
--   * Views carry no row-level scope: this is the executive/BI path (CD-92),
--     so access control is "who may log in to Metabase", set in Metabase
--     groups — not per-row. Do not wire these views back into the app.

\set ON_ERROR_STOP on

-- --- role -------------------------------------------------------------------
-- psql does not interpolate :variables inside DO blocks, so build the
-- statement in SQL and run it with \gexec instead.

SELECT format('CREATE ROLE metabase_ro LOGIN PASSWORD %L', :'mb_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'metabase_ro')
\gexec

-- --- schema -----------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS reporting;

-- --- requests ---------------------------------------------------------------

CREATE OR REPLACE VIEW reporting.requests AS
SELECT
  r.id,
  r."requestNo"                         AS request_no,
  r."typeCode"                          AS type_code,
  rt.name                               AS type_name,
  c.code                                AS company_code,
  c.name                                AS company_name,
  ou.code                               AS requester_unit_code,
  ou.name                               AS requester_unit,
  u."displayName"                       AS requester,
  r.status::text                        AS status,
  r.source::text                        AS source,
  r."createdAt"                         AS created_at,
  r."submittedAt"                       AS submitted_at,
  r."dueAt"                             AS due_at,
  r."completedAt"                       AS completed_at,
  r."cancelledAt"                       AS cancelled_at,
  (r.status = 'completed')              AS is_completed,
  (r.status IN ('completed','rejected','cancelled')) AS is_terminal,
  CASE
    WHEN r."completedAt" IS NOT NULL AND r."submittedAt" IS NOT NULL
    THEN EXTRACT(EPOCH FROM (r."completedAt" - r."submittedAt")) / 3600.0
  END                                   AS cycle_hours
FROM requests r
JOIN request_types rt ON rt.id  = r."requestTypeId"
JOIN companies     c  ON c.id   = r."companyId"
LEFT JOIN users    u  ON u.id   = r."requesterId"
LEFT JOIN org_units ou ON ou.id = r."requesterOrgUnitId";

-- --- approval steps ---------------------------------------------------------

CREATE OR REPLACE VIEW reporting.approval_steps AS
SELECT
  s.id,
  ac.id                                 AS case_id,
  ac."subjectType"                      AS subject_type,
  ac.amount                             AS amount,
  ac.currency                           AS currency,
  ac.status::text                       AS case_status,
  ac."requestId"                        AS request_id,
  r."requestNo"                         AS request_no,
  c.code                                AS company_code,
  s."stepNo"                            AS step_no,
  s."approverRole"                      AS approver_role,
  ua."displayName"                      AS approver,
  ud."displayName"                      AS decided_by,
  (s."delegationId" IS NOT NULL)        AS via_delegation,
  s.status::text                        AS step_status,
  s.decision::text                      AS decision,
  s."createdAt"                         AS created_at,
  s."decidedAt"                         AS decided_at,
  CASE
    WHEN s."decidedAt" IS NOT NULL
    THEN EXTRACT(EPOCH FROM (s."decidedAt" - s."createdAt")) / 3600.0
  END                                   AS decision_hours
FROM approval_steps s
JOIN approval_cases ac ON ac.id = s."caseId"
JOIN companies      c  ON c.id  = ac."companyId"
LEFT JOIN requests  r  ON r.id  = ac."requestId"
LEFT JOIN users     ua ON ua.id = s."approverUserId"
LEFT JOIN users     ud ON ud.id = s."decidedByUserId";

-- --- SLA clocks -------------------------------------------------------------

CREATE OR REPLACE VIEW reporting.sla_clocks AS
SELECT
  sc.id,
  sc."requestId"                        AS request_id,
  r."requestNo"                         AS request_no,
  r."typeCode"                          AS type_code,
  c.code                                AS company_code,
  sc.state::text                        AS state,
  sc."startedAt"                        AS started_at,
  sc."pausedAt"                         AS paused_at,
  sc."dueAt"                            AS due_at,
  sc."warnedAt"                         AS warned_at,
  sc."breachedAt"                       AS breached_at,
  sc."escalatedAt"                      AS escalated_at,
  sc."accumulatedMs" / 3600000.0        AS running_hours,
  (sc.state = 'met')                    AS met,
  (sc."breachedAt" IS NOT NULL)         AS breached,
  -- Now equal to sla_status = 'overdue' (it used to miss a paused request
  -- that had already breached).
  (sc.state IN ('running','paused')
    AND (sc."breachedAt" IS NOT NULL
         OR (sc.state = 'running' AND sc."dueAt" < now()))) AS overdue_now,
  -- Columns below were added by CD-50/CD-67. New columns go at the END:
  -- CREATE OR REPLACE VIEW refuses to insert or reorder, and this file is
  -- re-run on installs that already have the view.
  rt.name                               AS type_name,
  ro.id                                 AS receiver_unit_id,
  ro.name                               AS receiver_unit,
  r."completedAt"                       AS completed_at,
  -- CD-50 — the one definition of คำขอค้างเกินกำหนด; the same CASE is
  -- SLA_STATUS_SQL in services/core-service/src/sla/sla-status.ts, and
  -- sla-status.spec.ts fails if the two differ.
  -- sla_status BEGIN
CASE
  WHEN sc.state = 'met'       THEN 'on_time'
  WHEN sc.state = 'breached'  THEN 'late'
  WHEN sc.state = 'cancelled' THEN 'cancelled'
  WHEN sc."breachedAt" IS NOT NULL
    OR (sc.state = 'running' AND sc."dueAt" < now()) THEN 'overdue'
  ELSE 'on_track'
END
  -- sla_status END
                                        AS sla_status,
  -- CD-67 response clock (cases only)
  r.severity::text                      AS severity,
  sc."responseDueAt"                    AS response_due_at,
  sc."respondedAt"                      AS responded_at,
  sc."responseBreachedAt"               AS response_breached_at
FROM sla_clocks sc
JOIN requests      r  ON r.id  = sc."requestId"
JOIN request_types rt ON rt.id = r."requestTypeId"
JOIN companies     c  ON c.id  = r."companyId"
LEFT JOIN org_units ro ON ro.id = r."receiverOrgUnitId";

-- --- SLA compliance per month (CD-50) ---------------------------------------
-- Finished work only, by the Bangkok month it was completed in — the same
-- population as GET /reports/sla-compliance?group_by=month.

CREATE OR REPLACE VIEW reporting.sla_compliance_monthly AS
SELECT
  company_code,
  to_char(completed_at AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM') AS month,
  receiver_unit,
  type_code,
  type_name,
  count(*)                                          AS finished,
  count(*) FILTER (WHERE sla_status = 'on_time')    AS on_time,
  count(*) FILTER (WHERE sla_status = 'late')       AS late,
  round(100.0 * count(*) FILTER (WHERE sla_status = 'on_time')
        / nullif(count(*), 0), 1)                   AS compliance_pct
FROM reporting.sla_clocks
WHERE sla_status IN ('on_time','late') AND completed_at IS NOT NULL
GROUP BY 1, 2, 3, 4, 5;

-- --- request events (per-step timing → bottleneck, REQ-09) ------------------

CREATE OR REPLACE VIEW reporting.request_events AS
SELECT
  e.id,
  e."requestId"                         AS request_id,
  r."requestNo"                         AS request_no,
  r."typeCode"                          AS type_code,
  e.seq,
  e.type                                AS event_type,
  e."fromStatus"::text                  AS from_status,
  e."toStatus"::text                    AS to_status,
  COALESCE(u."displayName", e."actorLabel") AS actor,
  e."createdAt"                         AS created_at,
  EXTRACT(EPOCH FROM (
    e."createdAt" - LAG(e."createdAt") OVER (PARTITION BY e."requestId" ORDER BY e.seq)
  )) / 3600.0                           AS hours_since_previous
FROM request_events e
JOIN requests   r ON r.id = e."requestId"
LEFT JOIN users u ON u.id = e."actorId";

-- --- grants -----------------------------------------------------------------

REVOKE ALL ON SCHEMA public FROM metabase_ro;

-- GRANT CONNECT needs a literal database name; do it dynamically.
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO metabase_ro', current_database());
END $$;

GRANT USAGE ON SCHEMA reporting TO metabase_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA reporting TO metabase_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA reporting GRANT SELECT ON TABLES TO metabase_ro;
