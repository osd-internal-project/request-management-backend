-- P3 — a disbursement is visible to whoever may open its request. That rule
-- used to fetch the id of every visible request and send them back as an IN
-- list; a relation lets it be one query. Additive: one foreign key on a
-- column that is already unique. Checked on the live DB on 12 Nov 2026:
-- 7 disbursements, 0 whose request is missing. Requests are never hard-deleted.

ALTER TABLE "disbursements" ADD CONSTRAINT "disbursements_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
