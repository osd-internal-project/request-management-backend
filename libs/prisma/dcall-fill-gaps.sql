-- Fill what an already-seeded D CALL is missing (17 Nov 2026), for a database reached through an ssh tunnel:
--   1. each person's unit in D CALL's chart = D CALL's copy of their OSD unit (OSD's placement is untouched)
--   2. OSD's product catalog as D CALL's own rows
-- Idempotent: fills only empty placements and missing product codes; safe to re-run.
--
--   Needs: migration 20261117100000_user_company_org_unit applied, companies OSD and DCALL.
--   Trial run without saving: change the last line COMMIT → ROLLBACK and read the NOTICE counts.
--   Run:  psql "host=localhost port=15432 dbname=<db> user=<user>" -v ON_ERROR_STOP=1 -f dcall-fill-gaps.sql
--   Mock requests are NOT here: request numbers come only from run-number-service — raise them through the API.

BEGIN;

DO $$
DECLARE
  v_osd    text;
  v_dcall  text;
  v_placed int;
  v_prod   int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'user_companies' AND column_name = 'orgUnitId') THEN
    RAISE EXCEPTION 'Apply migration 20261117100000_user_company_org_unit first.';
  END IF;
  SELECT id INTO v_osd FROM companies WHERE code = 'OSD';
  SELECT id INTO v_dcall FROM companies WHERE code = 'DCALL';
  IF v_osd IS NULL OR v_dcall IS NULL THEN RAISE EXCEPTION 'Companies OSD and DCALL must both exist.'; END IF;

  -- 1. Placement: OSD unit → D CALL unit with the same code (OSD's root became code DCALL)
  UPDATE user_companies d
  SET "orgUnitId" = nu.id
  FROM user_companies s
  JOIN org_units ou ON ou.id = s."orgUnitId"
  JOIN org_units nu ON nu."companyId" = v_dcall
   AND nu.code = CASE WHEN ou."parentId" IS NULL AND ou.kind = 'COMPANY' THEN 'DCALL' ELSE ou.code END
  WHERE s."companyId" = v_osd
    AND d."companyId" = v_dcall
    AND d."userId" = s."userId"
    AND d."orgUnitId" IS NULL;
  GET DIAGNOSTICS v_placed = ROW_COUNT;

  -- 2. Products
  INSERT INTO products (id, "companyId", code, name, unit, "groupCode", "groupName", active, source, "syncedAt", "updatedAt")
  SELECT gen_random_uuid()::text, v_dcall, p.code, p.name, p.unit, p."groupCode", p."groupName", p.active, p.source, p."syncedAt", now()
  FROM products p WHERE p."companyId" = v_osd
  ON CONFLICT ("companyId", code) DO NOTHING;
  GET DIAGNOSTICS v_prod = ROW_COUNT;

  RAISE NOTICE 'D CALL: placed now=% (total placed=% of % members) · products added=% (total=%, OSD=%)',
    v_placed,
    (SELECT count(*) FROM user_companies WHERE "companyId" = v_dcall AND "orgUnitId" IS NOT NULL),
    (SELECT count(*) FROM user_companies WHERE "companyId" = v_dcall),
    v_prod,
    (SELECT count(*) FROM products WHERE "companyId" = v_dcall),
    (SELECT count(*) FROM products WHERE "companyId" = v_osd);
END $$;

COMMIT;
