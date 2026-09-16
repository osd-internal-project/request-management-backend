import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../modules/prisma/prisma.service';
import { TQueryClient, TxOption } from '../modules/prisma/types';
import { BaseRepository } from '../repositories/base.repository';

/**
 * The columns a directory row carries.
 *
 * A `select` rather than the whole `User` row, because both callers hand this
 * to somebody who is choosing a name: a requester picking a receiver, an
 * administrator picking a head, a chatbot turning "คุณจารุภา" into an id.
 * `keycloakId`, `keycloakRoles` and `supervisorUserId` answer none of those
 * questions and travel out of the system every time they are selected.
 *
 * The HR columns below joined them on 16 Sep 2026 (the staff-register import).
 * They are here because the same question — "who is this person and how do I
 * reach them" — is what a directory is for; `extension` in particular is the
 * one people ask for out loud. Adding a column here publishes it to every
 * employee and every integration at once, so the test for the next one is the
 * same: does somebody choosing a name need it?
 */
const DIRECTORY_SELECT = {
  id: true,
  displayName: true,
  username: true,
  email: true,
  position: true,
  employeeId: true,
  extension: true,
  startWork: true,
  phone: true,
  orgUnitId: true,
  orgUnit: { select: { name: true } },
} as const;

type DirectoryRow = Prisma.UserGetPayload<{ select: typeof DIRECTORY_SELECT }>;

/**
 * Reads of the people directory, shared by every service that needs one.
 *
 * Lives in `libs/share` rather than in either service because both need the
 * same answer and had started to answer it differently: user-service returned
 * whole `User` rows from `GET /users`, while core-service grew
 * `CompanyMemberRepository.findInUnits` for the receiver picker — same table,
 * same question, two shapes and two sets of columns. One repository is what
 * stops the third one being written.
 */
@Injectable()
export class DirectoryRepository extends BaseRepository<PrismaService['user']> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.user;
  }

  search(
    where: Prisma.UserWhereInput,
    args: { skip: number; take: number },
    option?: TxOption,
  ): Promise<DirectoryRow[]> {
    const client = option?.prisma ?? this.prisma;

    return client.user.findMany({
      where,
      select: DIRECTORY_SELECT,
      orderBy: { displayName: 'asc' },
      skip: args.skip,
      take: args.take,
    });
  }

  countWhere(where: Prisma.UserWhereInput, option?: TxOption): Promise<number> {
    return this.count({ where }, option);
  }
}

export type { DirectoryRow };
