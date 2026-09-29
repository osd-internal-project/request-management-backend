import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AppError,
  AuditWriter,
  auditActor,
  BaseRepository,
  hasPermission,
  Principal,
  PrismaService,
  type TQueryClient,
} from '@request-management/share';
import { CompanyMemberRepository } from '../access/company-member.repository';
import { backgroundTick } from '../common/background-tick';
import { NotificationRulesService } from '../notifications/notification-rules.service';
import { NotificationsService } from '../notifications/notifications.service';
import { contractVisibleWhere } from './contract-visibility';
import { CustomerContractRepository } from './contract.repositories';
import {
  CompleteObligationDto,
  SaveObligationDto,
} from './dto/legal-contract.dto';
import { bangkokDay } from './kyc-rules';

/** CD-163 ข้อผูกพันตามสัญญา. */
@Injectable()
export class ContractObligationRepository extends BaseRepository<
  PrismaService['contractObligation']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.contractObligation;
  }
}

const DEFAULT_INTERVAL_MS = 3_600_000;
const DAY_MS = 86_400_000;
const RULE = 'contract.obligation';

export interface ObligationRow {
  id: string;
  companyId: string;
  contractId: string;
  title: string;
  ownerUserId: string;
  dueOn: Date | null;
  status: string;
  warnedFor: Date | null;
  overdueFor: Date | null;
}

const SELECT = {
  id: true,
  contractId: true,
  title: true,
  detail: true,
  clause: true,
  ownerUserId: true,
  dueOn: true,
  status: true,
  doneAt: true,
  doneBy: true,
  doneNote: true,
  createdAt: true,
} as const;

const asDay = (value: string) => new Date(`${value.slice(0, 10)}T00:00:00Z`);
const day = (value: Date | null) =>
  value ? value.toISOString().slice(0, 10) : null;

/**
 * What an open obligation needs now: nothing, the "coming due" warning, or
 * the overdue notice — once per due date each.
 */
export function obligationNotice(
  row: Pick<ObligationRow, 'status' | 'dueOn' | 'warnedFor' | 'overdueFor'>,
  today: Date,
  warnDays: number,
): 'due' | 'overdue' | null {
  if (row.status !== 'open' || !row.dueOn) return null;
  const due = row.dueOn.getTime();
  if (due < today.getTime()) {
    return row.overdueFor?.getTime() === due ? null : 'overdue';
  }
  if (due - today.getTime() > warnDays * DAY_MS) return null;
  return row.warnedFor?.getTime() === due ? null : 'due';
}

/**
 * CD-163 — ติดตามข้อผูกพัน. Legal breaks a contract into obligations, each
 * with an owner and a date; the owner — often not in Legal (project,
 * service team) — is told when it is handed to them, warned before it is due
 * (the company's `contract.obligation` rule, standard 3 days) and once when
 * it is overdue, and sees their own under "ข้อผูกพันของฉัน" to mark done.
 *
 * - on the contract: read with `legal.contract.read` (the contract's own
 *   visibility), written with `legal.contract.manage`;
 * - "mine" and "done" need only a signed-in person (`notification.read`) and
 *   show just the obligation and its contract's number and title;
 * - done: the owner, or Legal on their behalf; waived: Legal only.
 */
@Injectable()
export class ContractObligationsService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(ContractObligationsService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly obligations: ContractObligationRepository,
    private readonly contracts: CustomerContractRepository,
    private readonly members: CompanyMemberRepository,
    private readonly rules: NotificationRulesService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditWriter,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const interval =
      this.config.get<number>('crm.obligationIntervalMs') ??
      DEFAULT_INTERVAL_MS;
    if (interval <= 0) return;
    this.timer = setInterval(
      backgroundTick(this.logger, 'CD-163 obligations', () => this.sweep()),
      interval,
    );
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // --- on the contract (Legal) ---------------------------------------------

  async listForContract(contractId: string, actor: Principal) {
    await this.requireContract(contractId, actor);
    const rows = (await this.obligations.findMany({
      where: { contractId },
      orderBy: [{ status: 'asc' }, { dueOn: 'asc' }, { createdAt: 'asc' }],
      select: SELECT,
    })) as ({ ownerUserId: string; doneBy: string | null } & Record<
      string,
      unknown
    >)[];
    const names = await this.displayNames(
      rows.flatMap((row) => [row.ownerUserId, row.doneBy]),
    );
    return rows.map((row) => ({
      ...row,
      ownerName: names.get(row.ownerUserId) ?? row.ownerUserId,
      doneByName: row.doneBy ? (names.get(row.doneBy) ?? row.doneBy) : null,
    }));
  }

  async create(contractId: string, dto: SaveObligationDto, actor: Principal) {
    const contract = await this.requireContract(contractId, actor);
    const title = dto.title?.trim();
    if (!title || !dto.owner_user_id) {
      throw new AppError(
        'VALIDATION_FAILED',
        'ต้องระบุข้อผูกพันและผู้รับผิดชอบ',
        [{ field: 'obligation', reason: 'required' }],
      );
    }
    await this.assertMember(contract.companyId, dto.owner_user_id);
    const row = (await this.obligations.create({
      data: {
        companyId: contract.companyId,
        contractId,
        title,
        detail: dto.detail?.trim() || null,
        clause: dto.clause?.trim() || null,
        ownerUserId: dto.owner_user_id,
        dueOn: dto.due_on ? asDay(dto.due_on) : null,
        createdBy: actor.userId,
      },
    })) as ObligationRow;
    await this.audit.record({
      eventType: 'legal.obligation.created',
      companyId: contract.companyId,
      ...auditActor(actor),
      resourceType: 'customer_contract',
      resourceId: contractId,
      after: {
        obligationId: row.id,
        title,
        ownerUserId: dto.owner_user_id,
        dueOn: dto.due_on ?? null,
      },
    });
    if (dto.owner_user_id !== actor.userId) {
      await this.notifications.contractObligation(
        'assigned',
        dto.owner_user_id,
        contract.companyId,
        { title, dueOn: dto.due_on?.slice(0, 10) ?? null },
        contract,
      );
    }
    return row;
  }

  async update(
    contractId: string,
    obligationId: string,
    dto: SaveObligationDto,
    actor: Principal,
  ) {
    const contract = await this.requireContract(contractId, actor);
    const before = await this.requireObligation(obligationId, contractId);
    if (dto.owner_user_id && dto.owner_user_id !== before.ownerUserId) {
      await this.assertMember(contract.companyId, dto.owner_user_id);
    }
    const dueOn =
      dto.due_on === undefined
        ? undefined
        : dto.due_on
          ? asDay(dto.due_on)
          : null;
    const dueChanged = dueOn !== undefined && day(dueOn) !== day(before.dueOn);
    const row = (await this.obligations.update({
      where: { id: obligationId },
      data: {
        ...(dto.title?.trim() ? { title: dto.title.trim() } : {}),
        ...(dto.detail !== undefined
          ? { detail: dto.detail?.trim() || null }
          : {}),
        ...(dto.clause !== undefined
          ? { clause: dto.clause?.trim() || null }
          : {}),
        ...(dto.owner_user_id ? { ownerUserId: dto.owner_user_id } : {}),
        ...(dueOn !== undefined ? { dueOn } : {}),
        // a new date is a new reminder and a new overdue notice
        ...(dueChanged ? { warnedFor: null, overdueFor: null } : {}),
        ...(dto.status === 'waived' || dto.status === 'open'
          ? {
              status: dto.status,
              ...(dto.status === 'open'
                ? { doneAt: null, doneBy: null, doneNote: null }
                : {}),
            }
          : {}),
      },
    })) as ObligationRow;
    await this.audit.record({
      eventType: 'legal.obligation.updated',
      companyId: contract.companyId,
      ...auditActor(actor),
      resourceType: 'customer_contract',
      resourceId: contractId,
      before: {
        obligationId,
        ownerUserId: before.ownerUserId,
        dueOn: day(before.dueOn),
        status: before.status,
      },
      after: {
        obligationId,
        ownerUserId: row.ownerUserId,
        dueOn: day(row.dueOn),
        status: row.status,
      },
    });
    if (
      row.ownerUserId !== before.ownerUserId &&
      row.ownerUserId !== actor.userId &&
      row.status === 'open'
    ) {
      await this.notifications.contractObligation(
        'assigned',
        row.ownerUserId,
        contract.companyId,
        { title: row.title, dueOn: day(row.dueOn) },
        contract,
      );
    }
    return row;
  }

  // --- the owner -----------------------------------------------------------

  /** ข้อผูกพันของฉัน — open first, soonest first; done within 30 days. */
  async mine(actor: Principal) {
    const since = new Date(Date.now() - 30 * DAY_MS);
    const rows = await this.obligations.findMany({
      where: {
        ownerUserId: actor.userId,
        companyId: actor.activeCompanyId,
        OR: [{ status: 'open' }, { status: 'done', doneAt: { gte: since } }],
      },
      orderBy: [{ status: 'desc' }, { dueOn: 'asc' }],
      select: {
        ...SELECT,
        contract: {
          select: {
            id: true,
            contractNo: true,
            title: true,
            counterpartyName: true,
            customer: { select: { nameTh: true } },
          },
        },
      },
      take: 200,
    });
    // May the owner open the contract itself? The link shows only then.
    const openable = new Set(
      (
        (await this.contracts.findMany({
          where: {
            id: {
              in: (rows as { contractId: string }[]).map(
                (row) => row.contractId,
              ),
            },
            ...contractVisibleWhere(actor),
          },
          select: { id: true },
        })) as { id: string }[]
      ).map((row) => row.id),
    );
    const canRead = hasPermission(actor, 'legal.contract.read');
    return (rows as { contractId: string }[]).map((row) => ({
      ...row,
      contractOpenable: canRead && openable.has(row.contractId),
    }));
  }

  async complete(
    obligationId: string,
    dto: CompleteObligationDto,
    actor: Principal,
  ) {
    const row = (await this.obligations.findFirst({
      where: { id: obligationId, companyId: actor.activeCompanyId },
    })) as ObligationRow | null;
    const mayAct =
      row &&
      (row.ownerUserId === actor.userId ||
        hasPermission(actor, 'legal.contract.manage'));
    if (!row || !mayAct) {
      throw new AppError('NOT_FOUND', 'ไม่พบข้อผูกพันที่ระบุ');
    }
    if (row.status !== 'open') {
      throw new AppError('CONFLICT', 'ข้อผูกพันนี้ปิดไปแล้ว');
    }
    const updated = await this.obligations.update({
      where: { id: obligationId },
      data: {
        status: 'done',
        doneAt: new Date(),
        doneBy: actor.userId,
        doneNote: dto.note?.trim() || null,
      },
    });
    await this.audit.record({
      eventType: 'legal.obligation.done',
      companyId: row.companyId,
      ...auditActor(actor),
      resourceType: 'customer_contract',
      resourceId: row.contractId,
      after: { obligationId, note: dto.note?.trim() || null },
    });
    return updated;
  }

  // --- the sweep -----------------------------------------------------------

  async sweep(
    now: Date = new Date(),
  ): Promise<{ due: number; overdue: number }> {
    const tally = { due: 0, overdue: 0 };
    const rule = await this.rules.across(RULE);
    const enabled = [rule.standard, ...rule.byCompany.values()].filter(
      (one) => one.enabled,
    );
    if (!enabled.length) return tally;
    const widest = Math.max(
      ...enabled.map((one) => one.params.warn_days as number),
    );
    const today = new Date(`${bangkokDay(now)}T00:00:00Z`);
    const rows = (await this.obligations.findMany({
      where: {
        status: 'open',
        dueOn: { lte: new Date(today.getTime() + widest * DAY_MS) },
      },
      include: { contract: { select: { contractNo: true } } },
      take: 500,
    })) as unknown as (ObligationRow & { contract: { contractNo: string } })[];

    for (const row of rows) {
      const own = rule.of(row.companyId);
      if (!own.enabled) continue;
      const notice = obligationNotice(
        row,
        today,
        own.params.warn_days as number,
      );
      if (!notice) continue;
      // Guarded on the stamp as read: an overlapping tick tells nobody twice.
      const claimed = await this.obligations.updateMany({
        where:
          notice === 'due'
            ? { id: row.id, warnedFor: row.warnedFor }
            : { id: row.id, overdueFor: row.overdueFor },
        data:
          notice === 'due'
            ? { warnedFor: row.dueOn }
            : { overdueFor: row.dueOn },
      });
      if (claimed.count !== 1) continue;
      await this.notifications.contractObligation(
        notice,
        row.ownerUserId,
        row.companyId,
        { title: row.title, dueOn: day(row.dueOn) },
        row.contract,
      );
      tally[notice] += 1;
    }
    if (tally.due || tally.overdue) {
      this.logger.log(
        `CD-163: ${tally.due} coming due · ${tally.overdue} overdue`,
      );
    }
    return tally;
  }

  // --- helpers -------------------------------------------------------------

  private async requireContract(id: string, actor: Principal) {
    const found = (await this.contracts.findFirst({
      where: {
        id,
        companyId: actor.activeCompanyId,
        ...contractVisibleWhere(actor),
      },
      select: { id: true, companyId: true, contractNo: true },
    })) as { id: string; companyId: string; contractNo: string } | null;
    if (!found) throw new AppError('NOT_FOUND', 'ไม่พบสัญญาที่ระบุ');
    return found;
  }

  private async requireObligation(id: string, contractId: string) {
    const row = (await this.obligations.findFirst({
      where: { id, contractId },
    })) as ObligationRow | null;
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบข้อผูกพันที่ระบุ');
    return row;
  }

  private async assertMember(companyId: string, userId: string) {
    const member = await this.members.findFirst({
      where: {
        id: userId,
        status: 'ACTIVE',
        companies: { some: { companyId } },
      },
      select: { id: true },
    });
    if (!member) {
      throw new AppError(
        'VALIDATION_FAILED',
        'ผู้รับผิดชอบต้องเป็นผู้ใช้ที่ยังทำงานอยู่ในบริษัทนี้',
        [{ field: 'owner_user_id', reason: userId }],
      );
    }
  }

  private async displayNames(ids: (string | null)[]) {
    const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
    if (!unique.length) return new Map<string, string>();
    const users = (await this.members.findMany({
      where: { id: { in: unique } },
      select: { id: true, displayName: true },
    })) as { id: string; displayName: string }[];
    return new Map(users.map((user) => [user.id, user.displayName]));
  }
}
