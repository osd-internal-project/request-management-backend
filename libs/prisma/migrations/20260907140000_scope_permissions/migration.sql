-- What a scope grant lets the viewer *do*, not just see (7 ก.ย. 2569).
--
-- `canAct` was one boolean over the whole grant, so an administrator could say
-- "this group may work on that group's requests" but never "…may approve RND's
-- work while only reading Sale's". This column says exactly that, as codes from
-- the catalog declared in `libs/share/src/policy/permissions.ts`.
--
-- The backfill grants precisely what `canAct` granted and nothing more. On the
-- day this runs `canAct` reached exactly two authorities — `carrier_or_lead`
-- (return) and `requester_or_lead` (cancel) — so writing the wider set the
-- column *looks* like it meant would hand out authority nobody had yesterday.
ALTER TABLE "org_unit_scopes"
  ADD COLUMN "permissions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

UPDATE "org_unit_scopes"
   SET "permissions" = ARRAY['request.return', 'request.cancel.any']
 WHERE "canAct" = true;
