import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { PrismaTransactionService } from '@request-management/share';
import {
  RunNumberCounterRepository,
  RunNumberSettingRepository,
} from './run-number.repository';
import { RunNumberService } from './run-number.service';

/**
 * CM-02 (CD-115) AC: "20 concurrent creates → 20 รหัส ไม่ซ้ำ ไม่ข้ามเลข".
 *
 * `run-number.service.spec.ts` mocks `$queryRaw`, so it cannot show what the
 * guarantee actually rests on: the single `INSERT … ON CONFLICT … RETURNING`
 * statement under real Postgres row locking. This suite runs that statement
 * for real, twenty callers at once, each in its own transaction.
 *
 * It needs a migrated database and so is skipped unless one is named:
 *
 *   RUN_NUMBER_DB_TEST_URL=postgresql://… yarn workspace \
 *     @request-management/run-number-service test run-number.concurrency
 *
 * It writes only counter rows under a scopeKey of its own and deletes them
 * afterwards — no settings, no documents.
 */
const DB_URL = process.env.RUN_NUMBER_DB_TEST_URL;
const CONCURRENT = 20;

(DB_URL ? describe : describe.skip)(
  'CM-02 run number under concurrency (real Postgres)',
  () => {
    let prisma: PrismaClient;
    let service: RunNumberService;
    let companyId: string;
    // One key per run: the counter starts from nothing, and reruns never meet.
    const scopeKey = `cd115-${randomUUID()}`;

    beforeAll(async () => {
      prisma = new PrismaClient({
        datasources: { db: { url: DB_URL } },
      });
      const repoClient = prisma as never;
      service = new RunNumberService(
        new RunNumberSettingRepository(repoClient),
        new RunNumberCounterRepository(repoClient),
        new PrismaTransactionService(repoClient),
      );

      const company = await prisma.company.findFirst({
        select: { id: true },
      });
      if (!company) throw new Error('database has no company to issue for');
      companyId = company.id;
    });

    afterAll(async () => {
      if (!prisma) return;
      await prisma.runNumberCounter.deleteMany({ where: { scopeKey } });
      await prisma.$disconnect();
    });

    it('CM-02: 20 simultaneous CUSTOMER issues → 20 distinct codes, consecutive sequence', async () => {
      const at = new Date();
      const issued = await Promise.all(
        Array.from({ length: CONCURRENT }, () =>
          service.issue({
            companyId,
            docType: 'CUSTOMER',
            scopeKey,
            companyPrefix: 'TST',
            companyCode: 'TST',
            at,
          }),
        ),
      );

      const codes = issued.map((result) => result.number);
      expect(new Set(codes).size).toBe(CONCURRENT);

      // No skipped numbers: the sequences are exactly start … start+19.
      const seqs = issued.map((result) => result.seq).sort((a, b) => a - b);
      const start = seqs[0];
      expect(seqs).toEqual(
        Array.from({ length: CONCURRENT }, (_, index) => start + index),
      );

      // The counter row agrees with what was handed out.
      const counter = await prisma.runNumberCounter.findFirst({
        where: { companyId, docType: 'CUSTOMER', scopeKey },
        select: { lastSeq: true },
      });
      expect(counter?.lastSeq).toBe(start + CONCURRENT - 1);
    });
  },
);
