import type { Prisma } from '@prisma/client';
import {
  hasPermission,
  ownedBranches,
  type Principal,
} from '@request-management/share';

/**
 * CD-161 — which contracts a person may see, wherever contracts are listed
 * (the repository, the customer's contract tab).
 *
 * Q9 (12 พ.ย. 2569): an ordinary contract is reached like any owned row —
 * owner, author, a person granted by name, or a unit the caller leads, reaches
 * by role level or was granted; `legal.contract.read.all` reads every ordinary
 * contract. A confidential one (ลับพิเศษ) stays with `legal.contract.manage`,
 * its owner, whoever recorded it and its access list: no unit or grant opens it.
 */
export function contractVisibleWhere(
  actor: Principal,
): Prisma.CustomerContractWhereInput {
  const company = { companyId: actor.activeCompanyId };
  if (hasPermission(actor, 'legal.contract.manage')) return company;

  // A machine key acts for the company, so it keeps reading every ordinary contract.
  const readsAll =
    actor.isServiceAccount || hasPermission(actor, 'legal.contract.read.all');

  const ordinary: Prisma.CustomerContractWhereInput = readsAll
    ? { confidential: false }
    : {
        confidential: false,
        OR: ownedBranches(actor, {
          users: ['ownerUserId', 'createdBy'],
          unit: 'ownerOrgUnitId',
        }) as Prisma.CustomerContractWhereInput[],
      };

  return {
    ...company,
    OR: [
      ordinary,
      { ownerUserId: actor.userId },
      { createdBy: actor.userId },
      { access: { some: { userId: actor.userId } } },
    ],
  };
}
