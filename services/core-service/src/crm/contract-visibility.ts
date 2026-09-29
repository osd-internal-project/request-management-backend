import type { Prisma } from '@prisma/client';
import { hasPermission, type Principal } from '@request-management/share';

/**
 * CD-161 — which contracts a person may see, wherever contracts are listed
 * (the repository, the customer's contract tab). An ordinary contract: anyone
 * who reaches it. A confidential one (ลับพิเศษ): `legal.contract.manage`, its
 * owner, whoever recorded it, and the people on its access list — nobody
 * else, whatever else they may read.
 */
export function contractVisibleWhere(
  actor: Principal,
): Prisma.CustomerContractWhereInput {
  if (hasPermission(actor, 'legal.contract.manage')) return {};
  return {
    OR: [
      { confidential: false },
      { ownerUserId: actor.userId },
      { createdBy: actor.userId },
      { access: { some: { userId: actor.userId } } },
    ],
  };
}
