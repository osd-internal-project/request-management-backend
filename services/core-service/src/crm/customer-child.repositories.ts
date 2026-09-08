import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  BaseRepository,
  PrismaService,
  TQueryClient,
} from '@request-management/share';

/**
 * The customer's child tables (CM-01/02/05), one thin repository each so data
 * access keeps going through the repository layer rather than `PrismaService`
 * directly. Domain rules live in `CustomersService`; nothing here decides
 * anything.
 */

@Injectable()
export class CustomerLocationRepository extends BaseRepository<
  PrismaService['customerLocation']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.customerLocation;
  }
}

@Injectable()
export class CustomerContactRepository extends BaseRepository<
  PrismaService['customerContact']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.customerContact;
  }
}

@Injectable()
export class CustomerExternalCodeRepository extends BaseRepository<
  PrismaService['customerExternalCode']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.customerExternalCode;
  }
}

/**
 * CM-01's per-field history. Append-only like the audit log: no update, no
 * delete — `BaseRepository` exposes both, so this one deliberately does NOT
 * extend it. `create`/`createMany`/`findMany` is the entire surface.
 */
@Injectable()
export class CustomerFieldChangeRepository {
  constructor(private readonly prisma: PrismaService) {}

  private client(option?: { prisma?: TQueryClient }) {
    return (option?.prisma ?? this.prisma).customerFieldChange;
  }

  createMany(
    data: Prisma.CustomerFieldChangeCreateManyInput[],
    option?: { prisma?: TQueryClient },
  ) {
    return this.client(option).createMany({ data });
  }

  findMany(
    args: Prisma.CustomerFieldChangeFindManyArgs,
    option?: { prisma?: TQueryClient },
  ) {
    return this.client(option).findMany(args);
  }
}
