-- `อ้างอิงดีล` becomes a per-type setting (1 ก.ย. 2569).
--
-- The submit screen demanded it for every request type, because §16 marks it
-- with `*`. That mockup is the DSC screen — a discount request, which really
-- does hang off a deal. Applied to all 45 types it blocked anything with no
-- deal to point at, "ของานออกแบบ / สื่อ / Event / AI Media" among them, and the
-- API had never required it.
--
-- Defaults to false, and only DSC is switched on: that is the one type whose
-- mockup asks for it, so this preserves §16 exactly where §16 has an opinion
-- and stops inventing a requirement everywhere else.
ALTER TABLE "request_types" ADD COLUMN "refRequired" BOOLEAN NOT NULL DEFAULT false;

UPDATE "request_types" SET "refRequired" = TRUE WHERE "code" = 'DSC';
