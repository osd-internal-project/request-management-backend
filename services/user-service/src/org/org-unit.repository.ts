import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  TQueryClient,
  TxOption,
} from '@request-management/share';
import type { OrgUnit, Prisma } from '@prisma/client';

@Injectable()
export class OrgUnitRepository extends BaseRepository<
  PrismaService['orgUnit']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.orgUnit;
  }

  findById(id: string, option?: TxOption): Promise<OrgUnit | null> {
    return this.findUnique({ where: { id } }, option);
  }

  findForCompany(companyId: string, option?: TxOption): Promise<OrgUnit[]> {
    return this.findMany(
      { where: { companyId }, orderBy: [{ kind: 'asc' }, { name: 'asc' }] },
      option,
    );
  }

  /**
   * The tree as screen A3 draws it: each node with its manager's name and how
   * many people sit in it directly. Done as one query with `include`/`_count`
   * rather than a lookup per node, so a deep tree stays a single round trip.
   */
  findForCompanyWithDetail(
    companyId: string,
    option?: TxOption,
  ): Promise<
    (OrgUnit & {
      manager: { id: string; displayName: string } | null;
      _count: { members: number };
    })[]
  > {
    const client = option?.prisma ?? this.prisma;

    return client.orgUnit.findMany({
      where: { companyId },
      include: {
        manager: { select: { id: true, displayName: true } },
        _count: { select: { members: true } },
      },
      orderBy: [{ kind: 'asc' }, { name: 'asc' }],
    });
  }

  /** All units in the company, used to rebuild the closure after an edit. */
  findAllForClosure(
    companyId: string,
    option?: TxOption,
  ): Promise<Pick<OrgUnit, 'id' | 'parentId' | 'kind'>[]> {
    return this.findMany(
      {
        where: { companyId },
        select: { id: true, parentId: true, kind: true },
      },
      option,
    );
  }

  createUnit(
    data: Prisma.OrgUnitUncheckedCreateInput,
    option?: TxOption,
  ): Promise<OrgUnit> {
    return this.create({ data }, option);
  }

  updateUnit(
    id: string,
    data: Prisma.OrgUnitUncheckedUpdateInput,
    option?: TxOption,
  ): Promise<OrgUnit> {
    return this.update({ where: { id }, data }, option);
  }
}
