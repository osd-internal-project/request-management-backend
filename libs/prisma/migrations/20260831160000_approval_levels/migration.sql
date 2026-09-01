-- The approval ladder stops being a set of amount bands. 31 Aug 2026.
--
-- §8.1 and APV-01 describe a matrix of ceilings — team lead below T1, CFO above
-- it, CEO above T2. The ceilings were never confirmed: T1 and T2 are still open
-- question A, unanswered by Finance since 24 Aug, and every environment has been
-- running placeholder numbers. What the departments actually asked for is a
-- ladder of *people*: either the requester's own line of management, or named
-- groups and the people in them.
--
-- This is a **declared amendment** to §8.1/APV-01, recorded the same way the
-- request lifecycle amendment is in `request-state-machine.ts`. See
-- `matrix-rules.ts` for the rules that replace the ceiling rules, and
-- `docs/screen-checklist.json` for the A1 wording that went with them.
--
-- `levels` is a new column rather than a rewrite of `tiers`, and `tiers` keeps
-- its NOT NULL: a version published before today must still read, because the
-- cases routed under it are explained by it (§7 — running work keeps the rules
-- it started under). New versions write both, `tiers` holding a single
-- open-ended entry so the old readers still resolve.
ALTER TABLE "approval_matrices" ADD COLUMN "levels" JSONB;

-- A level can resolve to several people, any one of whom may decide.
-- `approverUserId` stays as the first of them: it is what the history, the
-- step list and every case routed before today already read.
ALTER TABLE "approval_steps" ADD COLUMN "candidateUserIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Backfill so the inbox query can move to the array in one step rather than
-- reading both columns for ever.
UPDATE "approval_steps"
   SET "candidateUserIds" = ARRAY["approverUserId"]
 WHERE "approverUserId" IS NOT NULL;

CREATE INDEX "approval_steps_candidateUserIds_idx"
  ON "approval_steps" USING GIN ("candidateUserIds");
