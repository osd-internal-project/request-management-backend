-- ทีมผู้รับ becomes a default rather than a fixed rule (31 Aug 2026).
--
-- `RequestType.receiverOrgUnitId` has existed since the foundation migration
-- but no runtime code ever read it: a request was handed to a named person and
-- carried no team at all. So "ทีมผู้รับ" on the request-type screen configured
-- nothing.
--
-- The request now carries the team it was sent to. It is seeded from the type
-- and the requester may change it, which is why it lives on the row rather
-- than being read back off the type — editing a type must never re-route work
-- already in flight (REQ-01).
--
-- No foreign key and no backfill, both on purpose. Like `requesterOrgUnitId`
-- beside it this records where the work sat at the time, so an org-chart edit
-- must not rewrite it; and requests raised before today were never sent to a
-- team, so inventing one for them would be inventing history.
ALTER TABLE "requests" ADD COLUMN "receiverOrgUnitId" TEXT;

CREATE INDEX "requests_companyId_receiverOrgUnitId_status_idx"
  ON "requests"("companyId", "receiverOrgUnitId", "status");
