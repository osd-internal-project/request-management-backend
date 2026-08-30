-- A request becomes a ticket (28 Aug 2026).
--
-- The interim request logs describe work that is handed to a named person,
-- accepted, sometimes passed on, sometimes broken into further requests, and
-- only then checked and closed. None of that had anywhere to live: a request
-- knew who raised it and nothing about who was carrying it.
--
-- `06_EXAMPLE` is the worked case — one customer order becoming ten requests
-- across eight departments, each with RECEIVED / ASSIGNED / COMPLETED rows.
--
-- **This is a local amendment to §7.1 and §8.1 awaiting PO sign-off**, in the
-- same declared way as `on_hold` and `closed`. See the doc comment on
-- `request-state-machine.ts` for what comes back out if it is declined.
ALTER TABLE "requests" ADD COLUMN "receiverUserId" TEXT;
ALTER TABLE "requests" ADD COLUMN "assigneeUserId" TEXT;
ALTER TABLE "requests" ADD COLUMN "parentRequestId" TEXT;
ALTER TABLE "requests" ADD COLUMN "closedAt" TIMESTAMP(3);

ALTER TABLE "requests" ADD CONSTRAINT "requests_receiverUserId_fkey"
  FOREIGN KEY ("receiverUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "requests" ADD CONSTRAINT "requests_assigneeUserId_fkey"
  FOREIGN KEY ("assigneeUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "requests" ADD CONSTRAINT "requests_parentRequestId_fkey"
  FOREIGN KEY ("parentRequestId") REFERENCES "requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "requests_companyId_receiverUserId_status_idx"
  ON "requests"("companyId", "receiverUserId", "status");
CREATE INDEX "requests_companyId_assigneeUserId_status_idx"
  ON "requests"("companyId", "assigneeUserId", "status");
CREATE INDEX "requests_parentRequestId_idx" ON "requests"("parentRequestId");
