import { Injectable } from '@nestjs/common';
import { AppError } from '@request-management/share';
import { OrgUnitRepository } from './org-unit.repository';
import { CompanyMemberRepository } from './company-member.repository';

/**
 * One level of an approval ladder, as `ApprovalMatrix.levels` stores it.
 *
 * Two shapes because the departments configure approval two ways. `supervisor`
 * follows the requester's own line of management and needs no maintenance when
 * people move; `org` names groups outright, which is what a standing committee
 * or a named office actually is.
 */
/** Per-level rules copied onto each step at open; absent keys keep today's behaviour. */
export interface LevelOptions {
  /** `all`: every candidate must approve; default `any`. */
  readonly mode?: 'any' | 'all';
  /** Default `always`; `reject_or_return` lets an approval go without a note. */
  readonly noteRequired?: 'always' | 'reject_or_return';
  /** The level applies only when this holds against the request's answers. */
  readonly condition?: {
    readonly field: string;
    readonly op: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq' | 'in';
    readonly value: unknown;
  };
  /** Hours this level has to decide before it escalates. */
  readonly slaHours?: number;
  /** v2 flow levels: whose chart a supervisor level climbs; default the requester's. */
  readonly chartOf?: 'requester' | 'worker';
}

export type MatrixLevel = LevelOptions &
  (
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
      }
  );

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
  constructor(
    private readonly orgUnits: OrgUnitRepository,
    private readonly members: CompanyMemberRepository,
  ) {}

  /**
   * Refuses a ladder that names groups or people this company does not have.
   *
   * `assertValidLevels` checks the *shape* and deliberately touches no
   * database, which left the targets unchecked: publishing an `org` level
   * pointing at a group that does not exist, or at one in another company,
   * succeeded. Nothing said so until a request was raised against the type and
   * routed to nobody — an approval mystery rather than the configuration error
   * it is. Found on 1 ก.ย. 2569 by publishing a ladder aimed at an all-zero id.
   *
   * One query per kind for the whole ladder, not one per level.
   */
  async assertLevelTargetsExist(
    levels: readonly MatrixLevel[],
    companyId: string,
  ): Promise<void> {
    const orgLevels = levels.filter(
      (level): level is Extract<MatrixLevel, { type: 'org' }> =>
        level.type === 'org',
    );
    if (!orgLevels.length) return;

    const unitIds = [...new Set(orgLevels.flatMap((l) => [...l.orgUnitIds]))];
    const userIds = [
      ...new Set(orgLevels.flatMap((l) => [...(l.userIds ?? [])])),
    ];

    const [assignable, memberIds] = await Promise.all([
      this.orgUnits.assignableIdsOf(unitIds, companyId),
      this.members.memberIdsOf(userIds, companyId),
    ]);

    /*
      Every missing target is reported together. Publishing is a form the admin
      fills in, and being told about one bad row at a time is the slowest way
      to fix a ladder — the same reason `assertSubmittable` collects its
      failures before throwing.
    */
    const details = [
      ...unitIds
        .filter((id) => !assignable.has(id))
        .map((id) => ({ field: 'levels.orgUnitIds', reason: id })),
      ...userIds
        .filter((id) => !memberIds.has(id))
        .map((id) => ({ field: 'levels.userIds', reason: id })),
    ];

    if (details.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        'ตารางอำนาจอนุมัติอ้างถึงหน่วยงานหรือผู้ใช้ที่ไม่มีอยู่ในบริษัทนี้',
        details,
      );
    }
  }

  /**
   * Refuses a chart owner who is not in this company.
   *
   * The preview endpoint is the one place a caller names *somebody else* whose
   * chart gets climbed, and user-service resolves a context by user id alone —
   * `ApprovalContextService.resolve` takes a company but never checks the user
   * against it. Without this, asking for the route of a user in another
   * company would answer with their supervisors, which is SCOPE-03's boundary
   * being crossed by a read.
   */
  async assertChartOwnerInCompany(
    userId: string,
    companyId: string,
  ): Promise<void> {
    const members = await this.members.memberIdsOf([userId], companyId);

    if (!members.has(userId)) {
      throw new AppError(
        'VALIDATION_FAILED',
        'ผู้รับที่เลือกไม่ได้อยู่ในบริษัทนี้',
        [{ field: 'chart_owner_user_id', reason: 'not a member' }],
      );
    }
  }

  /** Where this person sits in the company's chart; null when they sit nowhere. */
  orgUnitIdOf(userId: string, companyId: string): Promise<string | null> {
    return this.members.orgUnitIdOf(userId, companyId);
  }

  /**
   * What to call the people a level resolved to.
   *
   * The ids come from this service's own reading of the chart, so the names
   * come from the same database — see `CompanyMemberRepository.displayNamesOf`
   * for why that is not a break of the identity boundary.
   */
  async displayNamesOf(
    userIds: readonly string[],
    companyId: string,
  ): Promise<Map<string, string>> {
    return this.members.displayNamesOf(userIds, companyId);
  }

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
        ? await this.supervisorAt(
            level.up,
            subject.orgUnitId,
            subject.requesterId,
          )
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
    requesterId: string,
  ): Promise<string[]> {
    if (!orgUnitId) return [];

    const ancestors = await this.orgUnits.ancestorIdsOf(orgUnitId);
    const from = ancestors.slice(Math.max(up - 1, 0));
    if (!from.length) return [];

    const heads = await this.orgUnits.managersOf(from);
    // A requester who heads the group climbs to the next head rather than approving themselves.
    const head = heads.find((userId) => userId !== requesterId);

    return head ? [head] : [];
  }

  /** The people an `org` level names, or the heads of the groups it names. */
  private async namedApprovers(
    level: Extract<MatrixLevel, { type: 'org' }>,
  ): Promise<string[]> {
    if (level.userIds?.length) return [...level.userIds];

    return this.orgUnits.managersOf(level.orgUnitIds);
  }
}
