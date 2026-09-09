import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  BaseRepository,
  PrismaService,
  TQueryClient,
  TxOption,
} from '@request-management/share';

/** What the register list and the 360° header card need — no heavy children. */
export const CUSTOMER_LIST_SELECT = {
  id: true,
  customerCode: true,
  type: true,
  nameTh: true,
  nameEn: true,
  taxId: true,
  branchCode: true,
  branchName: true,
  headOfficeId: true,
  status: true,
  kycVerified: true,
  accountOwnerUserId: true,
  accountOwner: { select: { id: true, displayName: true } },
  segments: {
    select: {
      value: {
        select: {
          id: true,
          code: true,
          nameTh: true,
          dimension: { select: { id: true, code: true, nameTh: true } },
        },
      },
    },
  },
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.CustomerSelect;

@Injectable()
export class CustomerRepository extends BaseRepository<
  PrismaService['customer']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.customer;
  }

  /** One page of the register, and the count from the same `where` (SCOPE-02). */
  search(
    where: Prisma.CustomerWhereInput,
    options: {
      skip: number;
      take: number;
      orderBy?: Prisma.CustomerOrderByWithRelationInput;
    },
    option?: TxOption,
  ) {
    return this.findMany(
      {
        where,
        select: CUSTOMER_LIST_SELECT,
        skip: options.skip,
        take: options.take,
        orderBy: options.orderBy ?? { createdAt: 'desc' },
      },
      option,
    );
  }

  countWhere(where: Prisma.CustomerWhereInput, option?: TxOption) {
    return this.count({ where }, option);
  }

  /** The detail page: everything but the timeline, which pages separately. */
  findDetail(where: Prisma.CustomerWhereInput, option?: TxOption) {
    return this.findFirst(
      {
        where,
        include: {
          accountOwner: { select: { id: true, displayName: true } },
          locations: {
            where: { active: true },
            orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
          },
          headOffice: {
            select: {
              id: true,
              customerCode: true,
              nameTh: true,
              branchCode: true,
            },
          },
          branchCustomers: {
            where: { mergedIntoCustomerId: null },
            orderBy: { branchCode: 'asc' },
            select: {
              id: true,
              customerCode: true,
              nameTh: true,
              branchCode: true,
              branchName: true,
              status: true,
            },
          },
          contacts: {
            where: { active: true },
            orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
          },
          segments: {
            include: {
              value: {
                include: {
                  dimension: {
                    select: { id: true, code: true, nameTh: true },
                  },
                },
              },
            },
          },
          mergedInto: {
            select: { id: true, customerCode: true, nameTh: true },
          },
        },
      },
      option,
    );
  }
}
