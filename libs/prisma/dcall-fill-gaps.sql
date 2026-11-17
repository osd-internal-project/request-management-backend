-- Fill what an already-seeded D CALL is missing (17 Nov 2026), for a database reached through an ssh tunnel:
--   1. each person's unit in D CALL's chart = D CALL's copy of their OSD unit (OSD's placement is untouched)
--   2. OSD's product catalog as D CALL's own rows
-- Idempotent: fills only empty placements and missing product codes; safe to re-run.
--
--   Needs: companies OSD and DCALL. Step 1 runs only once migration 20261117100000_user_company_org_unit is
--   applied (backend 1.5.53+); before that it is skipped and only products are filled — re-run after migrating.
--   Never apply that migration by hand: prisma would try it again on the next deploy.
--   Trial run without saving: change the last line COMMIT → ROLLBACK and read the NOTICE counts.
--   Run:  psql "host=localhost port=15432 dbname=<db> user=<user>" -v ON_ERROR_STOP=1 -f dcall-fill-gaps.sql
--   Mock requests are NOT here: request numbers come only from run-number-service — raise them through the API.

BEGIN;

DO $$
DECLARE
  v_osd    text;
  v_dcall  text;
  v_placed int := 0;
  v_total_placed bigint;
  v_prod   int;
  v_has_col boolean := EXISTS (SELECT 1 FROM information_schema.columns
                               WHERE table_name = 'user_companies' AND column_name = 'orgUnitId');
BEGIN
  SELECT id INTO v_osd FROM companies WHERE code = 'OSD';
  SELECT id INTO v_dcall FROM companies WHERE code = 'DCALL';
  IF v_osd IS NULL OR v_dcall IS NULL THEN RAISE EXCEPTION 'Companies OSD and DCALL must both exist.'; END IF;

  -- 1. Placement: OSD unit → D CALL unit with the same code (OSD's root became code DCALL).
  --    EXECUTE so a database without the column never plans this statement; format(%L), not positional
  --    placeholders, because DataGrip/DBeaver read those in a script as bind parameters and prompt for them.
  IF v_has_col THEN
    EXECUTE format($q$
      UPDATE user_companies d
      SET "orgUnitId" = nu.id
      FROM user_companies s
      JOIN org_units ou ON ou.id = s."orgUnitId"
      JOIN org_units nu ON nu."companyId" = %2$L
       AND nu.code = CASE WHEN ou."parentId" IS NULL AND ou.kind = 'COMPANY' THEN 'DCALL' ELSE ou.code END
      WHERE s."companyId" = %1$L
        AND d."companyId" = %2$L
        AND d."userId" = s."userId"
        AND d."orgUnitId" IS NULL
    $q$, v_osd, v_dcall);
    GET DIAGNOSTICS v_placed = ROW_COUNT;
  ELSE
    RAISE NOTICE 'Placement skipped: migration 20261117100000_user_company_org_unit not applied yet — re-run after migrating.';
  END IF;

  -- 2. Products
  INSERT INTO products (id, "companyId", code, name, unit, "groupCode", "groupName", active, source, "syncedAt", "updatedAt")
  SELECT gen_random_uuid()::text, v_dcall, p.code, p.name, p.unit, p."groupCode", p."groupName", p.active, p.source, p."syncedAt", now()
  FROM products p WHERE p."companyId" = v_osd
  ON CONFLICT ("companyId", code) DO NOTHING;
  GET DIAGNOSTICS v_prod = ROW_COUNT;

  IF v_has_col THEN
    EXECUTE format($q$SELECT count(*) FROM user_companies WHERE "companyId" = %L AND "orgUnitId" IS NOT NULL$q$, v_dcall)
      INTO v_total_placed;
  END IF;
  RAISE NOTICE 'D CALL: placed now=% (total placed=% of % members) · products added=% (total=%, OSD=%)',
    v_placed,
    coalesce(v_total_placed::text, 'n/a — no column yet'),
    (SELECT count(*) FROM user_companies WHERE "companyId" = v_dcall),
    v_prod,
    (SELECT count(*) FROM products WHERE "companyId" = v_dcall),
    (SELECT count(*) FROM products WHERE "companyId" = v_osd);
END $$;

COMMIT;
