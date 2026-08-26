-- §7.1 amendment (26 Aug 2026): on_hold — a request parked mid-execution
-- waiting on an external factor. Reachable only from in_progress; resumes to
-- in_progress or is cancelled. Needed to carry over ON_HOLD rows from the
-- interim Excel request logs without collapsing them into in_progress.
ALTER TYPE "RequestStatus" ADD VALUE 'on_hold';
