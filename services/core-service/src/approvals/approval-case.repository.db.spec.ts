import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { ApprovalCaseRepository } from './approval-case.repository';

/**
 * APV-06 (CD-45) — `stepIdsByBasis` compares columns and an array on the same
 * row in raw SQL, where NULL does not behave like false. The unit spec mocks
 * the query, so it could not see the bug this suite was written after: a step
 * routed to candidates has no `approverUserId`, `x = NULL` is NULL, and the
 * out-of-chain filter silently returned nothing.
 *
 * Needs a migrated database with at least one company and one user; skipped
 * otherwise:
 *
 *   CORE_DB_TEST_URL=postgresql://… yarn workspace \
 *     @request-management/core-service test approval-case.repository.db
 *
 * Writes one case with four steps under ids of its own and deletes them.
 */
const DB_URL = process.env.CORE_DB_TEST_URL;

(DB_URL ? describe : describe.skip)(
  'APV-06 decision basis in SQL (real Postgres)',
  () => {
    let prisma: PrismaClient;
    let repo: ApprovalCaseRepository;
    let companyId: string;
    const caseId = `apv06-${randomUUID()}`;
    const ids = {
      named: `${caseId}-named`,
      candidate: `${caseId}-candidate`,
      delegate: `${caseId}-delegate`,
      outside: `${caseId}-outside`,
    };
    const window = {
      start: new Date(Date.now() - 60 * 60 * 1000),
      end: new Date(Date.now() + 60 * 60 * 1000),
    };

    beforeAll(async () => {
      prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
      repo = new ApprovalCaseRepository(prisma as never);

      const company = await prisma.company.findFirstOrThrow({
        select: { id: true },
      });
      const users = await prisma.user.findMany({
        select: { id: true },
        take: 1,
      });
      if (!users.length) throw new Error('database has no user to decide');
      companyId = company.id;
      const actor = users[0].id;
      const delegation = await prisma.delegation.findFirst({
        select: { id: true },
      });

      await prisma.approvalCase.create({
        data: {
          id: caseId,
          companyId,
          subjectType: 'test:apv06',
          subjectId: caseId,
          snapshotHash: 'test',
          status: 'approved',
        },
      });
      const decided = {
        decision: 'approve' as const,
        status: 'approved' as const,
        decidedAt: new Date(),
      };
      await prisma.approvalStep.createMany({
        data: [
          // named approver decides
          {
            id: ids.named,
            caseId,
            stepNo: 1,
            approverRole: 'r',
            approverUserId: actor,
            decidedByUserId: actor,
            ...decided,
          },
          // candidate step (no named approver) decided by a candidate
          {
            id: ids.candidate,
            caseId,
            stepNo: 2,
            approverRole: 'r',
            candidateUserIds: [actor],
            decidedByUserId: actor,
            ...decided,
          },
          // candidate step decided by someone who is neither — the exception
          {
            id: ids.outside,
            caseId,
            stepNo: 3,
            approverRole: 'r',
            candidateUserIds: ['someone-else'],
            decidedByUserId: actor,
            ...decided,
          },
          ...(delegation
            ? [
                {
                  id: ids.delegate,
                  caseId,
                  stepNo: 4,
                  approverRole: 'r',
                  delegationId: delegation.id,
                  decidedByUserId: actor,
                  ...decided,
                },
              ]
            : []),
        ],
      });
    });

    afterAll(async () => {
      if (!prisma) return;
      await prisma.approvalStep.deleteMany({ where: { caseId } });
      await prisma.approvalCase.deleteMany({ where: { id: caseId } });
      await prisma.$disconnect();
    });

    const mine = (found: string[]) =>
      found.filter((id) => id.startsWith(caseId)).sort();

    it('APV-06: chain = the named approver or a listed candidate', async () => {
      expect(
        mine(await repo.stepIdsByBasis(companyId, window, 'chain')),
      ).toEqual([ids.candidate, ids.named].sort());
    });

    it('APV-06: scope_grant = decided by someone outside the chain, with no approver named', async () => {
      expect(
        mine(await repo.stepIdsByBasis(companyId, window, 'scope_grant')),
      ).toEqual([ids.outside]);
    });

    it('APV-06: delegate = decided under a delegation', async () => {
      const found = mine(
        await repo.stepIdsByBasis(companyId, window, 'delegate'),
      );
      // Only asserted when the database had a delegation to point at.
      expect(found).toEqual(found.length ? [ids.delegate] : []);
    });
  },
);
