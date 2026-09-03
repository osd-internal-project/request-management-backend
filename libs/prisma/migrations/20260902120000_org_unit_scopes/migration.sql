-- Which group may see which group's work (2 ก.ย. 2569).
--
-- The replacement for `scope_rules`, which stored a level per role
-- (own/team/department/company/all) and was withdrawn on 31 ส.ค. 2569 because
-- a `(role, resource) → level` row can say "this role sees its department" but
-- never "ฝ่ายขาย sees ฝ่ายการตลาด". This table says exactly that.
--
-- `scope_rules` is deliberately left in place and still unread by every
-- authorisation path. Dropping it is a migration of its own, after this one has
-- run in production and the admin screen has been used.
--
-- A grant is inherited downwards: it is matched against a person's own unit and
-- every unit above it, so one written at company level applies to everybody in
-- that company. Nothing here encodes that — it is resolved in
-- `OrgService.scopedUnitIdsOf` against `org_closure`.
CREATE TABLE "org_unit_scopes" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "viewerOrgUnitId" TEXT NOT NULL,
    "targetOrgUnitId" TEXT NOT NULL,
    -- Naming a ฝ่าย almost always means its แผนก too, so reaching the subtree
    -- is the default and turning it off is what has to be asked for.
    "includeDescendants" BOOLEAN NOT NULL DEFAULT true,
    -- Read-only by default. `assertMayAct` in core-service is the only thing
    -- standing between a person and somebody else's ticket, and a grant that
    -- silently widened it would hand over the chart.
    "canAct" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "org_unit_scopes_pkey" PRIMARY KEY ("id")
);

-- One grant per pair: the screen replaces the whole list for a viewer, and a
-- second row for the same target would make "does this group see that one"
-- answerable two ways.
CREATE UNIQUE INDEX "org_unit_scopes_viewerOrgUnitId_targetOrgUnitId_key"
    ON "org_unit_scopes"("viewerOrgUnitId", "targetOrgUnitId");

-- The resolve path's only query: every grant held by a person's unit and its
-- ancestors, in the active company.
CREATE INDEX "org_unit_scopes_companyId_viewerOrgUnitId_idx"
    ON "org_unit_scopes"("companyId", "viewerOrgUnitId");

ALTER TABLE "org_unit_scopes"
    ADD CONSTRAINT "org_unit_scopes_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- Cascade on both ends: a grant naming a deleted group is not a grant, and
-- `deleteUnit` already refuses while anything meaningful still points at a
-- unit.
ALTER TABLE "org_unit_scopes"
    ADD CONSTRAINT "org_unit_scopes_viewerOrgUnitId_fkey"
    FOREIGN KEY ("viewerOrgUnitId") REFERENCES "org_units"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "org_unit_scopes"
    ADD CONSTRAINT "org_unit_scopes_targetOrgUnitId_fkey"
    FOREIGN KEY ("targetOrgUnitId") REFERENCES "org_units"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
