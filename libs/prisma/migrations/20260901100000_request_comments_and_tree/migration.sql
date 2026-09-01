-- Comments on a request, and the path from it to the top. 1 Sep 2026.
--
-- **Comments.** People on a request had nowhere to say anything to each other.
-- Every note the system stored was attached to one transition — a return
-- reason, a hold reason, an approver's remark — and none of them could be
-- written without also moving the request. Append-only, like the audit log:
-- what was said on a request is part of its history, so there is no update
-- path and no delete path.
--
-- **The path.** `parentRequestId` gave one level. `06_EXAMPLE` traces ten
-- requests across eight departments from a single customer order, and the
-- screen has to show that whole chain — walking it with `parentRequestId`
-- alone is a query per level on every page view. `ancestorIds` holds the
-- lineage root-first, written once when the request is created from its
-- parent's own path, so "everything under request 1" is one indexed lookup.
--
-- Backfilled by walking each existing request up to its root. Depth is bounded
-- at 20, which is far beyond anything real and stops a cycle — which
-- `assertUsableParent` already refuses to create — from hanging the migration.
ALTER TABLE "requests" ADD COLUMN "ancestorIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

WITH RECURSIVE lineage AS (
    SELECT "id" AS "leaf", "parentRequestId" AS "ancestor", 1 AS depth
      FROM "requests"
     WHERE "parentRequestId" IS NOT NULL
    UNION ALL
    SELECT l."leaf", r."parentRequestId", l.depth + 1
      FROM lineage l
      JOIN "requests" r ON r."id" = l."ancestor"
     WHERE r."parentRequestId" IS NOT NULL AND l.depth < 20
)
UPDATE "requests" AS target
   SET "ancestorIds" = path."ids"
  FROM (
        SELECT "leaf", array_agg("ancestor" ORDER BY depth DESC) AS "ids"
          FROM lineage
         GROUP BY "leaf"
       ) AS path
 WHERE target."id" = path."leaf";

CREATE INDEX "requests_ancestorIds_idx" ON "requests" USING GIN ("ancestorIds");

CREATE TABLE "request_comments" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "request_comments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "request_comments_requestId_createdAt_idx"
  ON "request_comments"("requestId", "createdAt");

ALTER TABLE "request_comments" ADD CONSTRAINT "request_comments_requestId_fkey"
  FOREIGN KEY ("requestId") REFERENCES "requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "request_comments" ADD CONSTRAINT "request_comments_authorId_fkey"
  FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
