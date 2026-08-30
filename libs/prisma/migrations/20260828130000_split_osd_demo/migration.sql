-- Split the demo organisation out of OSD (28 Aug 2026).
--
-- The company row coded `OSD` held the invented data from mockup §16: the
-- ฝ่ายขาย / Getter 1 / Pricing tree, the DSC/LEAD/NDA/SOL request types, the
-- seven `uat.*` characters, and the placeholder approval ceilings. None of it
-- is the real organisation, and `OSD` now has to receive the departments' own
-- request logs (docs/REQUEST_RAW_STRUCTURE.md).
--
-- Renaming the existing row rather than moving its children is deliberate:
-- every org unit, role, user membership, matrix and request already points at
-- this row's id, so a rename carries all of them across untouched and there is
-- no window in which a foreign key is half-moved. `prisma:seed` then creates a
-- fresh, empty `OSD`.
--
-- `docPrefix` changes to OSDD for numbers issued from now on. Numbers already
-- issued are NOT rewritten — REQ-02 makes an issued request number immutable,
-- and rewriting history to tidy a prefix is worse than a mixed prefix.
--
-- No-op on a fresh database: seedCompanies() creates both rows directly.
UPDATE "companies"
   SET "code"      = 'OSD_DEMO',
       "name"      = 'OSD (Demo)',
       "docPrefix" = 'OSDD'
 WHERE "code" = 'OSD'
   AND NOT EXISTS (SELECT 1 FROM "companies" WHERE "code" = 'OSD_DEMO');

-- The A3 tree belongs to the demo company; its root should say so.
UPDATE "org_units" u
   SET "name" = 'บริษัท OSD (Demo)'
  FROM "companies" c
 WHERE u."companyId" = c."id"
   AND c."code" = 'OSD_DEMO'
   AND u."code" = 'ROOT'
   AND u."name" = 'บริษัท OSD';
