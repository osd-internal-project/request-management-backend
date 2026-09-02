-- One switch, two flags: bring the per-company rows back in line (1 ก.ย. 2569).
--
-- `listTypes` shows a type on the submit screen only when `RequestType.active`
-- AND `RequestTypeCompany.active` are both true. A2's "เปิดใช้งาน" switch wrote
-- only the first, and nothing anywhere wrote the second, so activating a type
-- could leave it invisible with nothing on screen explaining why.
--
-- `MK-01 "ของานออกแบบ / สื่อ / Event / AI Media"` was the row that surfaced it:
-- the only type in the database with `active = true` and a company row set
-- false. Written as a general condition rather than for that code, because the
-- same gap could have produced others.
--
-- Only ever turns a company row ON, and only for a type that is itself active —
-- it must not switch a type on in a company where somebody deliberately turned
-- it off, and there is no way to tell those apart, so the narrower direction is
-- the safe one. `updateType` now keeps the two in step going forward.
UPDATE "request_type_companies" AS rtc
   SET "active" = TRUE
  FROM "request_types" AS rt
 WHERE rtc."requestTypeId" = rt."id"
   AND rt."active" = TRUE
   AND rtc."active" = FALSE;
