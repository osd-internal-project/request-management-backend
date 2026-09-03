-- Track the realm role by its id, not only its name (2 ก.ย. 2569).
--
-- `keycloak_role_mappings.keycloakRole` holds the realm role's *name*, which is
-- what a token carries and therefore what `syncFromKeycloakRoles` matches on at
-- sign-in. A name is also the one thing about a realm role that can change.
--
-- When it did, nothing here noticed: the next token arrived with the new name,
-- this table still held the old one, `findMatching` returned nothing, and
-- `replaceMappedRoles` quietly removed that role from every holder. A whole
-- group of people lost their permissions at once with nothing on any screen
-- explaining it, and the mapping page went on showing the stale name as though
-- all were well.
--
-- The id does not change on a rename, so it is what lets the name be corrected.
-- Nullable and left empty here: `syncNamesFromKeycloak` fills it in on its
-- first run, matching the rows whose names still line up with the realm. A
-- backfill written here could not do that — it would need to call Keycloak.
ALTER TABLE "keycloak_role_mappings" ADD COLUMN "keycloakRoleId" TEXT;

CREATE INDEX "keycloak_role_mappings_keycloakRoleId_idx"
    ON "keycloak_role_mappings"("keycloakRoleId");
