import type { Prisma } from '@prisma/client';

/**
 * The next `seq` on a request's timeline. Locks the request row first so two
 * writers in flight queue instead of both reading the same last `seq`.
 */
export async function nextRequestEventSeq(
  prisma: Prisma.TransactionClient,
  requestId: string,
): Promise<number> {
  await prisma.$queryRaw`SELECT 1 FROM "requests" WHERE "id" = ${requestId} FOR UPDATE`;

  const last = await prisma.requestEvent.findFirst({
    where: { requestId },
    orderBy: { seq: 'desc' },
    select: { seq: true },
  });

  return (last?.seq ?? 0) + 1;
}
