import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { AccessSubject, visibleUsersWhere } from '../access/access-rules';
import {
  PageQueryDto,
  Paginated,
  paginated,
  toSkipTake,
} from '../http/pagination';
import { DirectoryRepository, DirectoryRow } from './directory.repository';

/** A colleague, as every screen and every integration sees one. */
export interface DirectoryEntry {
  readonly id: string;
  readonly displayName: string;
  readonly username: string;
  readonly email: string | null;
  /** The HR job title, free text. Empty for anyone imported without one. */
  readonly position: string | null;
  /** Null while the person sits in the `รอจัดสังกัด` queue (AUTH-04). */
  readonly orgUnitId: string | null;
  readonly orgUnitName: string | null;
}

/** What a caller may narrow the directory by. */
export interface DirectoryQuery extends PageQueryDto {
  /** Matches display name, username or email — what a person types. */
  q?: string;
  /** One group, exactly. Use `orgUnitIds` for a subtree. */
  org_unit_id?: string;
  /**
   * A resolved set of groups, for callers that already walked the chart.
   *
   * Given as ids rather than a root plus a flag because the closure lives in
   * one service and this repository is shared: expanding a subtree here would
   * mean a second traversal that could disagree with the caller's.
   */
  orgUnitIds?: readonly string[];
}

/**
 * The people directory, shared by user-service and core-service.
 *
 * **The company boundary is not this class's decision.** It comes from
 * {@link visibleUsersWhere}, the same function `GET /users` has always used,
 * so a caller cannot widen it by passing a different filter — SCOPE-03 says
 * the boundary is absolute, and a rule enforced in one place is the only kind
 * that stays enforced.
 *
 * Inactive accounts are excluded here rather than by each caller. A suspended
 * colleague is not somebody work can be handed to, and every caller that
 * forgot the filter would offer them.
 */
@Injectable()
export class DirectoryService {
  constructor(private readonly directory: DirectoryRepository) {}

  async searchUsers(
    subject: AccessSubject,
    query: DirectoryQuery,
  ): Promise<Paginated<DirectoryEntry>> {
    const where = this.whereFor(subject, query);
    const { skip, take } = toSkipTake(query);

    const [rows, total] = await Promise.all([
      this.directory.search(where, { skip, take }),
      this.directory.countWhere(where),
    ]);

    return paginated(rows.map(toEntry), query, total);
  }

  /**
   * The filter, exposed so a test can read it without a database.
   *
   * `orgUnitIds: []` is answered with a condition that matches nothing, not by
   * dropping the clause. An empty set means "the caller resolved a subtree and
   * it was empty" — someone in the `รอจัดสังกัด` queue asking for their team —
   * and dropping it there would answer with the whole company instead.
   */
  whereFor(
    subject: AccessSubject,
    query: DirectoryQuery,
  ): Prisma.UserWhereInput {
    const scoped = visibleUsersWhere(subject) as Prisma.UserWhereInput;
    const narrowing: Prisma.UserWhereInput[] = [{ status: 'ACTIVE' }];

    if (query.org_unit_id) {
      narrowing.push({ orgUnitId: query.org_unit_id });
    }

    if (query.orgUnitIds) {
      narrowing.push({ orgUnitId: { in: [...query.orgUnitIds] } });
    }

    const term = query.q?.trim();

    if (term) {
      narrowing.push({
        OR: [
          { displayName: { contains: term, mode: 'insensitive' } },
          { username: { contains: term, mode: 'insensitive' } },
          { email: { contains: term, mode: 'insensitive' } },
        ],
      });
    }

    return { AND: [scoped, ...narrowing] };
  }
}

function toEntry(row: DirectoryRow): DirectoryEntry {
  return {
    id: row.id,
    displayName: row.displayName,
    username: row.username,
    email: row.email,
    position: row.position,
    orgUnitId: row.orgUnitId,
    orgUnitName: row.orgUnit?.name ?? null,
  };
}
