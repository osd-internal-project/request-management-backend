/**
 * Remove the approval matrices published before the ladder stopped using
 * amounts.
 *
 *   MATRIX_CLEAR_ALLOW=1 yarn matrix:clear-legacy            # dry run
 *   MATRIX_CLEAR_ALLOW=1 yarn matrix:clear-legacy --apply    # write
 *
 * A legacy matrix is one with no `levels` — a ladder of amount ceilings, the
 * §8.1 shape withdrawn on 31 Aug 2026 (see the declared amendment in §8 of
 * `docs/ctd-foundation-spec.md`). Clearing them is what lets `selectTier`,
 * `ceilingIntroducing` and `amountFor` be deleted rather than kept alive for
 * rows nobody wants any more.
 *
 * **What survives.** `ApprovalCase.matrixId` is `ON DELETE SET NULL`, so every
 * case and every step stays exactly as it is: who was named, who decided, when,
 * and with what note. `matrixVersion` is a plain integer and keeps the version
 * number. The history of a decision is not the ladder that produced it.
 *
 * **What changes.** A subject type left with no published ladder has no
 * approval step at all — `complete` sends it straight to `approved`, which is
 * how a type with no matrix has always behaved (`routeForApproval`). Requests
 * already sitting in `pending_approval` are unaffected: `decide` reads the case
 * and its steps, never the matrix, so they can still be approved or rejected.
 *
 * Publish the replacement ladders on screen A1 before raising anything new of
 * those types.
 *
 * Idempotent — safe to re-run. Delete this file once every environment has
 * been through it.
 */
import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

function assertAllowed(): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'Refusing to run in production. This deletes published approval ladders.',
    );
  }

  if (process.env.MATRIX_CLEAR_ALLOW !== '1') {
    throw new Error(
      'Refusing to run without MATRIX_CLEAR_ALLOW=1.\n' +
        'This deletes every approval matrix published with amount ceilings. Re-run as:\n' +
        '  MATRIX_CLEAR_ALLOW=1 yarn matrix:clear-legacy --apply',
    );
  }
}

async function main(argv: readonly string[]): Promise<void> {
  assertAllowed();

  const apply = argv.includes('--apply');

  const legacy = await prisma.approvalMatrix.findMany({
    where: { levels: { equals: Prisma.DbNull } },
    select: {
      id: true,
      subjectType: true,
      version: true,
      publishedAt: true,
      company: { select: { code: true } },
    },
    orderBy: [{ subjectType: 'asc' }, { version: 'asc' }],
  });

  if (!legacy.length) {
    console.log('ไม่มีตารางอำนาจอนุมัติแบบเพดานวงเงินเหลืออยู่แล้ว');
    return;
  }

  const ids = legacy.map((matrix) => matrix.id);

  const [cases, openRequests] = await Promise.all([
    prisma.approvalCase.count({ where: { matrixId: { in: ids } } }),
    prisma.request.count({ where: { status: 'pending_approval' } }),
  ]);

  /*
    Which subject types are left with nothing routing them. Those are the ones
    an admin has to republish on A1 before anything new of that type is
    completed — until then it will finish without an approval step.
  */
  const replaced = new Set(
    (
      await prisma.approvalMatrix.findMany({
        where: { NOT: { levels: { equals: Prisma.DbNull } } },
        select: { subjectType: true },
      })
    ).map((matrix) => matrix.subjectType),
  );

  const orphaned = [
    ...new Set(
      legacy
        .filter((matrix) => !replaced.has(matrix.subjectType))
        .map((matrix) => `${matrix.company.code}/${matrix.subjectType}`),
    ),
  ];

  console.log(`\n${apply ? 'ลบ' : 'ตรวจ (dry run)'} ตารางอำนาจอนุมัติแบบเพดานวงเงิน`);
  console.log(`  เวอร์ชันที่จะลบ            ${legacy.length}`);
  for (const matrix of legacy) {
    console.log(
      `    ${matrix.company.code}/${matrix.subjectType} v${matrix.version}` +
        `${matrix.publishedAt ? '' : ' (ยังไม่ประกาศ)'}`,
    );
  }
  console.log(`  เคสที่อ้างอยู่ (ไม่ถูกลบ)    ${cases}`);
  console.log(`  คำขอที่รออนุมัติอยู่        ${openRequests}`);
  console.log(`  ประเภทงานที่จะไม่มีสายอนุมัติ ${orphaned.length}`);

  if (orphaned.length) {
    console.log(`    ${orphaned.join(' · ')}`);
    console.log('    → ประกาศสายอนุมัติใหม่ที่หน้า A1 ก่อนเปิดคำขอประเภทนี้');
  }

  if (!apply) {
    console.log('\n  ยังไม่เขียนอะไรลงฐาน — เติม --apply เมื่อตัวเลขข้างบนถูกต้อง');
    return;
  }

  const removed = await prisma.$transaction(async (tx) => {
    const result = await tx.approvalMatrix.deleteMany({
      where: { id: { in: ids } },
    });

    await tx.auditLog.create({
      data: {
        eventType: 'approval.matrix.legacy_cleared',
        actorUsername: 'matrix:clear-legacy (cli)',
        resourceType: 'approval_matrix',
        after: {
          removed: legacy.map(
            (matrix) =>
              `${matrix.company.code}/${matrix.subjectType} v${matrix.version}`,
          ),
          casesDetached: cases,
          subjectsLeftUnrouted: orphaned,
        } as Prisma.InputJsonValue,
      },
    });

    return result.count;
  });

  console.log(`\n  ลบแล้ว ${removed} เวอร์ชัน · เคสและขั้นอนุมัติเดิมยังอยู่ครบ`);
}

main(process.argv.slice(2))
  .then(() => console.log('Done.'))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
