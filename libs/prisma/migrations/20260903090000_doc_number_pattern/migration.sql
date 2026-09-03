-- The document number format, changed system-wide (3 ก.ย. 2569).
--
-- `OSD-DSC-202608-0042` becomes `REQ-OSD-PS01-26090001` — the format the
-- chatbot use case names. A literal `REQ` in front, the year as two digits, and
-- no separator before the sequence.
--
-- The company prefix stays in the middle rather than being dropped for the
-- shorter form the use case sketched. `requests."requestNo"` is UNIQUE across
-- the whole database while `doc_number_counters` resets per company per type
-- per month: a number with no company in it would have OSD and BCO both
-- issuing `REQ-PS01-26090001`, and the second submit of the month would fail
-- on the unique index rather than produce a duplicate.
--
-- Numbers already issued are NOT rewritten. A number is handed out once, at
-- submit, and is the identifier printed on paperwork already in circulation —
-- rows carrying the older form stay exactly as they are.
ALTER TABLE "doc_number_configs"
    ALTER COLUMN "pattern" SET DEFAULT 'REQ-{PREFIX}-{TYPE}-{YYMM}{SEQ}';

-- Only rows still carrying the old default. A pattern an administrator typed
-- is their decision, and `format()` still understands `{YYYYMM}`, so those keep
-- working untouched.
UPDATE "doc_number_configs"
   SET "pattern" = 'REQ-{PREFIX}-{TYPE}-{YYMM}{SEQ}'
 WHERE "pattern" = '{PREFIX}-{TYPE}-{YYYYMM}-{SEQ}';
