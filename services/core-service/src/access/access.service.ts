import { Injectable } from '@nestjs/common';
import { OrgUnitRepository } from './org-unit.repository';

/**
 * One level of an approval ladder, as `ApprovalMatrix.levels` stores it.
 *
 * Two shapes because the departments configure approval two ways. `supervisor`
 * follows the requester's own line of management and needs no maintenance when
 * people move; `org` names groups outright, which is what a standing committee
 * or a named office actually is.
 */
export type MatrixLevel =
  | {
      readonly type: 'supervisor';
      /**
       * How many levels of the chart above the requester. `1` is the head of
       * the group they sit in, `2` the department above it, and so on.
       */
      readonly up: number;
    }
  | {
      readonly type: 'org';
      readonly orgUnitIds: readonly string[];
      /** Empty means "the heads of those groups". */
      readonly userIds?: readonly string[];
    };

export interface ApproverSubject {
  readonly requesterId: string;
  /** Where the requester sat when the request was raised. */
  readonly orgUnitId: string | null;
}

/**
 * Who may approve — the one place that decides it.
 *
 * The same answer is needed twice and used to be computed twice: once when a
 * case is opened, to write the steps, and again when somebody presses approve,
 * to check they are allowed to. `resolveChain` and `authorise` each had their
 * own reading of the ladder, which is exactly the shape a drift bug takes —
 * a person named on a step who is then refused, or the reverse.
 *
 * It answers **a list**, not a person: a level can name several people and any
 * one of them is enough (`ApprovalStep.candidateUserIds`).
 */
@Injectable()
export class AccessService {
  constructor(private readonly orgUnits: OrgUnitRepository) {}

  /**
   * Everyone allowed to decide this level, for this requester.
   *
   * **Nobody approves their own request** (APV-02). The requester is removed
   * from every level, and a level left with nobody is skipped by the caller
   * rather than blocking — a manager raising a request should not have to find
   * somebody to pretend to be their own approver.
   */
  async approverCandidatesOf(
    level: MatrixLevel,
    subject: ApproverSubject,
  ): Promise<string[]> {
    const found =
      level.type === 'supervisor'
        ? await this.supervisorAt(level.up, subject.orgUnitId)
        : await this.namedApprovers(level);

    return [...new Set(found)].filter(
      (userId) => userId !== subject.requesterId,
    );
  }

  /**
   * The head `up` levels above where the requester sits.
   *
   * `ancestorIdsOf` is ordered nearest-first and includes the requester's own
   * group at index 0, so `up: 1` is that group's head.
   *
   * A group with no head does not end the search — it **climbs on**. The real
   * chart has groups nobody has been put in charge of yet, and stopping there
   * would mean a whole department could not submit anything until an admin
   * noticed. Running out of chart is the only failure, and the caller turns
   * that into `ORG_SUPERVISOR_MISSING`.
   */
  private async supervisorAt(
    up: number,
    orgUnitId: string | null,
  ): Promise<string[]> {
    if (!orgUnitId) return [];

    const ancestors = await this.orgUnits.ancestorIdsOf(orgUnitId);
    const from = ancestors.slice(Math.max(up - 1, 0));
    if (!from.length) return [];

    const heads = await this.orgUnits.managersOf(from);

    return heads.length ? [heads[0]] : [];
  }

  /** The people an `org` level names, or the heads of the groups it names. */
  private async namedApprovers(
    level: Extract<MatrixLevel, { type: 'org' }>,
  ): Promise<string[]> {
    if (level.userIds?.length) return [...level.userIds];

    return this.orgUnits.managersOf(level.orgUnitIds);
  }
}
