import { PrismaClient, RequestStatus } from '@prisma/client';

/**
 * NFR-02 — generate enough requests to measure the work queue and approval
 * inbox at 100,000 rows.
 *
 * Every row is tagged `refType: LOADTEST` so the set can be removed again:
 *
 *     yarn loadtest:seed          # insert up to the target
 *     yarn loadtest:clean         # delete every tagged row
 *
 * Rows are spread across requesters, statuses, and org units on purpose. A
 * hundred thousand identical rows would let the planner answer from a single
 * narrow index and report a speed the real table will never have.
 */
const TAG = 'LOADTEST';
const TARGET = Number(process.env.LOADTEST_ROWS ?? 100_000);
const BATCH = 2_000;

const STATUSES: RequestStatus[] = [
  'draft',
  'submitted',
  'pending_approval',
  'returned',
  'approved',
  'in_progress',
  'completed',
];

async function main(): Promise<void> {
  const prisma = new PrismaClient();

  try {
    const [company] = await prisma.company.findMany({ take: 1 });
    const type = await prisma.requestType.findFirst({ where: { active: true } });
    const users = await prisma.user.findMany({
      select: { id: true, orgUnitId: true },
      take: 50,
    });

    if (!company || !type || !users.length) {
      throw new Error('ต้อง seed ข้อมูลหลักก่อน — รัน yarn prisma:seed');
    }

    const existing = await prisma.request.count({ where: { refType: TAG } });
    const toCreate = Math.max(TARGET - existing, 0);

    console.log(
      `มีอยู่แล้ว ${existing.toLocaleString()} แถว · จะสร้างอีก ${toCreate.toLocaleString()}`,
    );

    const startedAt = Date.now();

    for (let created = 0; created < toCreate; created += BATCH) {
      const size = Math.min(BATCH, toCreate - created);

      await prisma.request.createMany({
        data: Array.from({ length: size }, (_, index) => {
          const n = existing + created + index;
          const user = users[n % users.length];
          const status = STATUSES[n % STATUSES.length];
          const submitted = status !== 'draft';

          return {
            requestTypeId: type.id,
            typeCode: type.code,
            companyId: company.id,
            requesterId: user.id,
            requesterOrgUnitId: user.orgUnitId,
            status,
            // Unique but obviously synthetic, so a load-test row is never
            // mistaken for a real request number in a report.
            requestNo: `LOAD-${String(n).padStart(8, '0')}`,
            formData: {
              deal_amount: 100_000 + (n % 900_000),
              discount_pct: n % 40,
              reason: 'load test',
            },
            refType: TAG,
            refId: String(n),
            submittedAt: submitted ? new Date() : null,
            createdBy: user.id,
            updatedBy: user.id,
          };
        }),
        skipDuplicates: true,
      });

      const done = Math.min(created + size, toCreate);
      if (done % 20_000 === 0 || done === toCreate) {
        console.log(`  ${done.toLocaleString()} / ${toCreate.toLocaleString()}`);
      }
    }

    const total = await prisma.request.count();
    console.log(
      `เสร็จใน ${((Date.now() - startedAt) / 1000).toFixed(1)} วิ · ` +
        `คำขอทั้งหมดในระบบ ${total.toLocaleString()}`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

void main();
