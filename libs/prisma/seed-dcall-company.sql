-- Create the "D CALL" company from OSD — the SQL form of seed-dcall-company.ts (`yarn dcall:seed`),
-- for a database reached only through an ssh tunnel. Same result, idempotent: safe to re-run.
--
--   Needs: migration 20261117100000_user_company_org_unit, company OSD, request type DCRQ001, and an OSD root
--   unit with a manager (else it rolls back). Already seeded before 17 Nov 2026? run dcall-fill-gaps.sql instead.
--   Trial run without saving: change the last line COMMIT → ROLLBACK and read the NOTICE counts.
--   Run:  psql "host=localhost port=15432 dbname=<db> user=<user>" -v ON_ERROR_STOP=1 -f seed-dcall-company.sql
--   PostgreSQL 13+ (gen_random_uuid). Keep in step with seed-dcall-company.ts.

BEGIN;

DO $$
DECLARE
  v_by   CONSTANT text   := 'seed-dcall-company';
  v_skip CONSTANT text[] := ARRAY['uat_superadmin'];  -- `yarn uat:seed` owns it (AGENTS.md)
  v_osd   text;
  v_dcall text;
  v_root  text;
  v_owner text;
  v_type  text;
  v_units int;
  mk record;
BEGIN
  SELECT id INTO v_osd FROM companies WHERE code = 'OSD';
  IF v_osd IS NULL THEN RAISE EXCEPTION 'No company "OSD" to copy from.'; END IF;
  IF NOT EXISTS (SELECT 1 FROM request_types WHERE code = 'DCRQ001') THEN
    RAISE EXCEPTION 'No request type DCRQ001 to copy.';
  END IF;

  -- 1. Company
  INSERT INTO companies (id, code, name, "docPrefix", "baseCurrency", "updatedAt")
  VALUES (gen_random_uuid()::text, 'DCALL', 'D CALL', 'DC', 'THB', now())
  ON CONFLICT (code) DO NOTHING;
  SELECT id INTO v_dcall FROM companies WHERE code = 'DCALL';

  -- 2. Roles with their permissions and scope rules (matched old → new by code)
  INSERT INTO roles (id, "companyId", code, name, description, "isSystem", active, "visibilityLevel", level, "createdBy", "updatedAt")
  SELECT gen_random_uuid()::text, v_dcall, r.code, r.name, r.description, r."isSystem", r.active, r."visibilityLevel", r.level, v_by, now()
  FROM roles r WHERE r."companyId" = v_osd AND r.code <> ALL (v_skip)
  ON CONFLICT ("companyId", code) DO UPDATE SET
    name = EXCLUDED.name, description = EXCLUDED.description, "isSystem" = EXCLUDED."isSystem", active = EXCLUDED.active,
    "visibilityLevel" = EXCLUDED."visibilityLevel", level = EXCLUDED.level, "updatedAt" = now();

  CREATE TEMP TABLE dcall_role_map ON COMMIT DROP AS
  SELECT r.id AS old_id, n.id AS new_id
  FROM roles r JOIN roles n ON n."companyId" = v_dcall AND n.code = r.code
  WHERE r."companyId" = v_osd AND r.code <> ALL (v_skip);

  INSERT INTO role_permissions ("roleId", "permissionCode")
  SELECT m.new_id, p."permissionCode" FROM role_permissions p JOIN dcall_role_map m ON m.old_id = p."roleId"
  ON CONFLICT DO NOTHING;

  INSERT INTO scope_rules (id, "roleId", resource, scope, "updatedAt")
  SELECT gen_random_uuid()::text, m.new_id, s.resource, s.scope, now() FROM scope_rules s JOIN dcall_role_map m ON m.old_id = s."roleId"
  ON CONFLICT ("roleId", resource) DO UPDATE SET scope = EXCLUDED.scope, "updatedAt" = now();

  -- 3. Org chart: OSD's root becomes DCALL / D CALL; parents are linked after every unit exists
  INSERT INTO org_units (id, "companyId", code, name, kind, "managerUserId", active, "createdBy", "updatedAt")
  SELECT gen_random_uuid()::text, v_dcall,
         CASE WHEN u."parentId" IS NULL AND u.kind = 'COMPANY' THEN 'DCALL' ELSE u.code END,
         CASE WHEN u."parentId" IS NULL AND u.kind = 'COMPANY' THEN 'D CALL' ELSE u.name END,
         u.kind, u."managerUserId", u.active, v_by, now()
  FROM org_units u WHERE u."companyId" = v_osd
  ON CONFLICT ("companyId", code) DO UPDATE SET
    name = EXCLUDED.name, kind = EXCLUDED.kind, "managerUserId" = EXCLUDED."managerUserId", active = EXCLUDED.active, "updatedAt" = now();

  CREATE TEMP TABLE dcall_unit_map ON COMMIT DROP AS
  SELECT u.id AS old_id, n.id AS new_id, u."parentId" AS old_parent
  FROM org_units u JOIN org_units n ON n."companyId" = v_dcall
   AND n.code = CASE WHEN u."parentId" IS NULL AND u.kind = 'COMPANY' THEN 'DCALL' ELSE u.code END
  WHERE u."companyId" = v_osd;
  GET DIAGNOSTICS v_units = ROW_COUNT;

  UPDATE org_units n
  SET "parentId" = (SELECT p.new_id FROM dcall_unit_map p WHERE p.old_id = m.old_parent), "updatedAt" = now()
  FROM dcall_unit_map m WHERE n.id = m.new_id;

  INSERT INTO org_closure ("ancestorId", "descendantId", depth)
  SELECT a.new_id, d.new_id, c.depth
  FROM org_closure c JOIN dcall_unit_map a ON a.old_id = c."ancestorId" JOIN dcall_unit_map d ON d.old_id = c."descendantId"
  ON CONFLICT DO NOTHING;

  SELECT id, "managerUserId" INTO v_root, v_owner FROM org_units WHERE "companyId" = v_dcall AND code = 'DCALL';
  IF v_root IS NULL THEN RAISE EXCEPTION 'OSD has no COMPANY root unit to copy.'; END IF;
  -- the copied root's manager owns the mocks; the chart is OSD's, so it has one
  IF v_owner IS NULL THEN RAISE EXCEPTION 'OSD''s root unit has no manager to own the mocks.'; END IF;

  -- 4. People: same members, same roles as MANUAL grants (Keycloak is login only)
  INSERT INTO user_companies (id, "userId", "companyId", "isPrimary")
  SELECT gen_random_uuid()::text, uc."userId", v_dcall, false FROM user_companies uc WHERE uc."companyId" = v_osd
  ON CONFLICT ("userId", "companyId") DO NOTHING;

  INSERT INTO user_roles (id, "userId", "roleId", "companyId", source)
  SELECT gen_random_uuid()::text, g."userId", m.new_id, v_dcall, 'MANUAL'
  FROM user_roles g JOIN dcall_role_map m ON m.old_id = g."roleId" WHERE g."companyId" = v_osd
  ON CONFLICT ("userId", "roleId", "companyId") DO NOTHING;

  -- Each person sits in D CALL's copy of their OSD unit (needs migration 20261117100000_user_company_org_unit)
  UPDATE user_companies d SET "orgUnitId" = m.new_id
  FROM user_companies s JOIN dcall_unit_map m ON m.old_id = s."orgUnitId"
  WHERE s."companyId" = v_osd AND d."companyId" = v_dcall AND d."userId" = s."userId" AND d."orgUnitId" IS NULL;

  -- OSD's product catalog as D CALL's own rows
  INSERT INTO products (id, "companyId", code, name, unit, "groupCode", "groupName", active, source, "syncedAt", "updatedAt")
  SELECT gen_random_uuid()::text, v_dcall, p.code, p.name, p.unit, p."groupCode", p."groupName", p.active, p.source, p."syncedAt", now()
  FROM products p WHERE p."companyId" = v_osd
  ON CONFLICT ("companyId", code) DO NOTHING;

  -- 5. Request type DC-RQ-001 copied from DCRQ001, received by the D CALL root unit
  INSERT INTO request_types (id, code, name, "receiverOrgUnitId", "formSchema", "receiverFormSchema", "requiredDocs",
    "returnReasonCodes", "subRequestTypes", "approvalPolicy", "slaHours", "slaCoverage", "refRequired", active,
    "createdBy", "updatedBy", "updatedAt")
  SELECT gen_random_uuid()::text, 'DC-RQ-001', 'D Call คำขอทั่วไป', v_root, s."formSchema", s."receiverFormSchema", s."requiredDocs",
    s."returnReasonCodes", s."subRequestTypes", s."approvalPolicy", s."slaHours", s."slaCoverage", s."refRequired", true,
    v_by, v_by, now()
  FROM request_types s WHERE s.code = 'DCRQ001'
  ON CONFLICT (code) DO UPDATE SET
    name = EXCLUDED.name, "receiverOrgUnitId" = EXCLUDED."receiverOrgUnitId", "formSchema" = EXCLUDED."formSchema",
    "receiverFormSchema" = EXCLUDED."receiverFormSchema", "requiredDocs" = EXCLUDED."requiredDocs",
    "returnReasonCodes" = EXCLUDED."returnReasonCodes", "subRequestTypes" = EXCLUDED."subRequestTypes",
    "approvalPolicy" = EXCLUDED."approvalPolicy", "slaHours" = EXCLUDED."slaHours", "slaCoverage" = EXCLUDED."slaCoverage",
    "refRequired" = EXCLUDED."refRequired", active = true, "updatedBy" = v_by, "updatedAt" = now();
  SELECT id INTO v_type FROM request_types WHERE code = 'DC-RQ-001';

  INSERT INTO request_type_companies ("requestTypeId", "companyId", active) VALUES (v_type, v_dcall, true)
  ON CONFLICT ("requestTypeId", "companyId") DO UPDATE SET active = true;

  -- 6. Mock data: 5 customers, each with a contract and a project (fixed ids, created once)
  FOR mk IN
    SELECT * FROM (VALUES
      (1, 'บริษัท ดีคอล เทคโนโลยี จำกัด', 'D Call Technology Co., Ltd.', 'corporate', 'ดีคอลเทคโนโลยี', 'ติดตั้งระบบ Call Center 50 ที่นั่ง'),
      (2, 'บริษัท สยามคอนแทค เซ็นเตอร์ จำกัด', 'Siam Contact Center Co., Ltd.', 'corporate', 'สยามคอนแทคเซ็นเตอร์', 'ย้ายระบบ IVR ขึ้น Cloud'),
      (3, 'บริษัท ไทยเน็ตเวิร์ค โซลูชั่น จำกัด', 'Thai Network Solution Co., Ltd.', 'corporate', 'ไทยเน็ตเวิร์คโซลูชั่น', 'บำรุงรักษาระบบโทรศัพท์ประจำปี'),
      (4, 'การไฟฟ้าส่วนภูมิภาค (ตัวอย่าง)', 'PEA (mock)', 'government', 'การไฟฟ้าส่วนภูมิภาคตัวอย่าง', 'เชื่อมต่อ CRM กับระบบ Call Center'),
      (5, 'คุณสมศรี ใจงาม', 'Somsri Jaingam', 'individual', 'คุณสมศรีใจงาม', 'อบรมพนักงาน Contact Center')
    ) AS t(n, name_th, name_en, kind, normalized, project)
  LOOP
    DECLARE
      nn  text    := lpad(mk.n::text, 2, '0');
      cus text    := 'mock-dcall-cus-' || lpad(mk.n::text, 2, '0');
      ctr text    := 'mock-dcall-ctr-' || lpad(mk.n::text, 2, '0');
      ctr_no text := 'CTR-DCALL-MOCK-' || lpad(mk.n::text, 2, '0');
      val numeric := 100000 * mk.n;
    BEGIN
      INSERT INTO customers (id, "customerCode", "companyId", type, "nameTh", "nameEn", "normalizedName", status,
        "accountOwnerUserId", "createdBy", "updatedAt")
      VALUES (cus, 'CUS-DCALL-MOCK-' || nn, v_dcall, mk.kind::"CustomerType", mk.name_th, mk.name_en, mk.normalized, 'active',
        v_owner, v_by, now())
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO customer_contracts (id, "companyId", "customerId", "contractNo", title, "startOn", "endOn", value, status,
        "ownerUserId", "signedOn", "signedVia", "signedRecordedBy", "createdBy", "updatedAt")
      VALUES (ctr, v_dcall, cus, ctr_no, 'สัญญา' || mk.project, current_date - 30, current_date + 335, val, 'active',
        v_owner, current_date - 37, 'manual', v_owner, v_by, now())
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO projects (id, "companyId", "projectNo", name, "contractId", "customerId", "managerUserId", status,
        "startOn", "endOn", "contractValue", baseline, "openedAt", "openedBy", note, "updatedAt")
      VALUES ('mock-dcall-prj-' || nn, v_dcall, 'PRJ-DCALL-MOCK-' || nn, mk.project, ctr, cus, v_owner, 'active',
        current_date - 30, current_date + 150, val,
        jsonb_build_object(
          'contract', jsonb_build_object('contractNo', ctr_no, 'title', 'สัญญา' || mk.project, 'party', mk.name_th, 'value', val, 'currency', 'THB'),
          'solution', jsonb_build_object('solutionId', NULL, 'title', mk.project, 'versionNo', 1),
          'scope', jsonb_build_object('inScope', '[]'::jsonb, 'outOfScope', '[]'::jsonb, 'deliverables', '[]'::jsonb, 'assumptions', '[]'::jsonb),
          'boq', '[]'::jsonb, 'labor', '[]'::jsonb, 'cost', NULL, 'installments', '[]'::jsonb,
          'capturedAt', to_char(current_date - 30, 'YYYY-MM-DD') || 'T00:00:00.000Z'),
        (current_date - 30)::timestamp, v_owner, 'ข้อมูลตัวอย่าง (mock)', now())
      ON CONFLICT (id) DO NOTHING;
    END;
  END LOOP;

  RAISE NOTICE 'D CALL % roles=% units=% members=% placed=% products=% grants=% customers=% projects=%', v_dcall,
    (SELECT count(*) FROM roles WHERE "companyId" = v_dcall), v_units,
    (SELECT count(*) FROM user_companies WHERE "companyId" = v_dcall),
    (SELECT count(*) FROM user_companies WHERE "companyId" = v_dcall AND "orgUnitId" IS NOT NULL),
    (SELECT count(*) FROM products WHERE "companyId" = v_dcall),
    (SELECT count(*) FROM user_roles WHERE "companyId" = v_dcall),
    (SELECT count(*) FROM customers WHERE "companyId" = v_dcall),
    (SELECT count(*) FROM projects WHERE "companyId" = v_dcall);
END $$;

COMMIT;
