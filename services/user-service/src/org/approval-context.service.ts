import { Injectable } from '@nestjs/common';
import { UsersRepository } from '../users/users.repository';
import { RolesService } from '../roles/roles.service';

/** Everything `resolveChain` needs, resolved on the identity side. */
export interface ApprovalContext {
  /** The group the requester sits in, for `supervisor` ladder levels. */
  orgUnitId: string | null;
  /** The requester's direct supervisor — step 1 of every chain (§8.1). */
  supervisorUserId: string | null;
  /**
   * The supervisors above them, nearest first. Needed because a team lead who
   * raises a request escalates to *their* supervisor rather than approving
   * their own submission.
   */
  supervisorChain: string[];
  /** Who currently holds each named office in this company (ROLE-04). */
  roleHolders: Record<string, string>;
  /**
   * `userId` → display name, for every id above.
   *
   * The engine routes by id, but §16 หน้าที่ 3 shows the chain as
   * "หัวหน้าทีม — สมหญิง จ." before the request is submitted. Names come from
   * here rather than a second lookup so the identity boundary stays one call.
   */
  displayNames: Record<string, string>;
}

/** Stops a cycle in the org chart from hanging the request. */
const MAX_CHAIN_DEPTH = 10;

/**
 * Supplies the approval engine with identity facts it must not read itself.
 *
 * core-service owns no identity tables — it asks for what it needs across a
 * named contract (see `GET /internal/org/approval-context`). Keeping that
 * boundary means the org chart stays one system's responsibility, so "who
 * reports to whom" cannot start disagreeing between services.
 */
@Injectable()
export class ApprovalContextService {
  constructor(
    private readonly users: UsersRepository,
    private readonly roles: RolesService,
  ) {}

  async resolve(userId: string, companyId: string): Promise<ApprovalContext> {
    const user = await this.users.findById(userId);
    const supervisorUserId = user?.supervisorUserId ?? null;

    const supervisorChain = await this.climb(supervisorUserId);
    const roleHolders = await this.roleHolders(companyId);

    const displayNames = await this.users.displayNamesOf([
      ...(supervisorUserId ? [supervisorUserId] : []),
      ...supervisorChain,
      ...Object.values(roleHolders),
    ]);

    return {
      // Where the requester sits. A ladder level of the `supervisor` kind
      // counts groups upward from here, so it travels with the rest of the
      // context rather than being fetched again on the other side of the
      // service boundary.
      orgUnitId: user?.orgUnitId ?? null,
      supervisorUserId,
      supervisorChain,
      roleHolders,
      displayNames,
    };
  }

  /** Walks upward from a starting point, guarding against a cyclic chart. */
  private async climb(startId: string | null): Promise<string[]> {
    const chain: string[] = [];
    const seen = new Set<string>();

    let currentId = startId;

    while (
      currentId &&
      !seen.has(currentId) &&
      chain.length < MAX_CHAIN_DEPTH
    ) {
      seen.add(currentId);

      const current = await this.users.findById(currentId);
      const next = current?.supervisorUserId ?? null;

      if (!next) break;

      chain.push(next);
      currentId = next;
    }

    return chain;
  }

  /**
   * The holders of the named approval offices.
   *
   * `team_lead` is deliberately absent: §8.1 resolves it from the org chart,
   * not from who holds the role, because step 1 must be *this requester's*
   * supervisor rather than any team lead in the company.
   */
  private async roleHolders(
    companyId: string,
  ): Promise<Record<string, string>> {
    const holders: Record<string, string> = {};

    for (const code of ['cfo', 'ceo', 'executive']) {
      const [holder] = await this.roles.holdersOfRole(companyId, code);
      if (holder) holders[code] = holder;
    }

    // §5.2 has no distinct CFO/CEO seed role yet — ผู้บริหาร (executive) stands
    // in for both until finance names real office holders (open question E).
    holders.cfo ??= holders.executive;
    holders.ceo ??= holders.executive;
    delete holders.executive;

    return holders;
  }
}
