-- One shape for a coded label: `name`, never `label` (1 ก.ย. 2569).
--
-- `requiredDocs` and `returnReasonCodes` are the same shape and share one DTO
-- (`CodedLabelDto` — `{ code, name }`), one frontend type (`CodedLabel`) and
-- one editor. `seed.ts` wrote `returnReasonCodes` with `label` instead, and
-- nothing caught it because `asDoc()` only ever reads `.code` when validating
-- a return reason.
--
-- What it did break was A2: the screen loaded a seeded type, got entries with
-- no `name`, sent them back untouched on save, and the DTO answered 400 with
-- `name should not be empty`. Neither seeded type could be edited at all.
--
-- Two rows on the environment where this was found (DSC and LEAD, both from
-- `seed.ts`); the other 41 types carry an empty list and one created through
-- the API was already correct.
--
-- `Request.typeSnapshot` is deliberately NOT rewritten. A snapshot is the rule
-- a request was raised under (§7 — running work keeps the rules it started
-- with), and `asDoc` falls back from `name` to `code`, so an old request's
-- reason list stays usable; it shows the code where it would have shown Thai.
-- Rewriting history to tidy a key is the worse trade.
--
-- Idempotent: an entry that already has `name` is left exactly as it is, so a
-- re-run and a fresh database (where `seed.ts` now writes `name`) are both
-- no-ops.
UPDATE "request_types"
   SET "returnReasonCodes" = (
         SELECT jsonb_agg(
                  CASE
                    WHEN entry ? 'label' AND NOT (entry ? 'name')
                      THEN (entry - 'label')
                           || jsonb_build_object('name', entry ->> 'label')
                    ELSE entry
                  END
                  ORDER BY ordinality
                )
           FROM jsonb_array_elements("returnReasonCodes")
                WITH ORDINALITY AS t(entry, ordinality)
       )
 WHERE EXISTS (
         SELECT 1
           FROM jsonb_array_elements("returnReasonCodes") AS entry
          WHERE entry ? 'label'
            AND NOT (entry ? 'name')
       );
