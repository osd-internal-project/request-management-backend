import { PrismaClient } from '@prisma/client';

/**
 * Removes everything `seed-load-test.ts` inserted.
 *
 * The counterpart matters as much as the seeder: a measurement set left behind
 * turns every later count, report, and bottleneck figure into a lie. Only rows
 * tagged `refType: LOADTEST` are touched, so real requests are never at risk.
 */
const TAG = 'LOADTEST';

async function main(): Promise<void> {
  const prisma = new PrismaClient();

  try {
    const ids = await prisma.request.findMany({
      where: { refType: TAG },
      select: { id: true },
    });

    if (!ids.length) {
      console.log('ไม่มีแถวทดสอบให้ลบ');

      return;
    }

    console.log(`พบ ${ids.length.toLocaleString()} แถวที่ติดป้าย ${TAG}`);

    // Children first — the load-test rows carry none today, but deleting in
    // this order keeps working if the seeder ever grows to create them.
    const requestIds = ids.map((row) => row.id);

    await prisma.slaClock.deleteMany({ where: { requestId: { in: requestIds } } });
    await prisma.requestEvent.deleteMany({
      where: { requestId: { in: requestIds } },
    });

    const { count } = await prisma.request.deleteMany({
      where: { refType: TAG },
    });

    console.log(`ลบแล้ว ${count.toLocaleString()} แถว`);
  } finally {
    await prisma.$disconnect();
  }
}

void main();
