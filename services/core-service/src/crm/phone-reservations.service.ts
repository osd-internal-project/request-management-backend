import {
  Inject,
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
  Principal,
  salesAccessSubject,
  visibleSalesWhere,
} from '@request-management/share';
import { CompanyMemberRepository } from '../access/company-member.repository';
import { backgroundTick } from '../common/background-tick';
import { NotificationRulesService } from '../notifications/notification-rules.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  PhoneNumberUnavailableError,
  RESERVE_PHONE_CLIENT,
  type PhoneReservation,
  type ReservePhoneClient,
  type ReservePhoneContext,
} from '../reserve-phone/reserve-phone-client';
import { CompanyRepository } from './product.repositories';
import {
  OpportunityPhoneReservationRepository,
  OpportunityRepository,
} from './sales.repositories';
import {
  ExtendPhoneReservationDto,
  ReservePhoneNumbersDto,
  SearchPhoneNumbersQueryDto,
} from './dto/sales.dto';
import { bangkokDay } from './kyc-rules';

const DEFAULT_INTERVAL_MS = 3_600_000;
const DAY_MS = 86_400_000;
const SEARCH_LIMIT = 30;

export interface ReservationDeal {
  id: string;
  companyId: string;
  opportunityCode: string;
  title: string;
  stage: string;
  ownerUserId: string;
}

export interface ReservationRow {
  id: string;
  companyId: string;
  opportunityId: string;
  number: string;
  category: string;
  externalReservationId: string;
  status: 'reserved' | 'released' | 'expired';
  expiresAt: Date;
  expiryWarnedFor: Date | null;
  createdBy: string;
}

const isUniqueViolation = (error: unknown) =>
  (error as { code?: string } | null)?.code === 'P2002';

/**
 * CD-78 — จองเลขหมายบริการ: a deal that sells a numbered service looks up free
 * numbers in Reserve-phone and holds them against the deal until a date.
 * Reserve-phone owns the inventory; this keeps only which hold belongs to
 * which deal (`opportunity_phone_reservations`), never a list of numbers.
 *
 * Reserve-phone is asked first and the row written second: a hold the row
 * cannot record (a second tab holding the same number — the partial unique
 * index) is handed back at once, so nothing stays held that no deal knows of.
 *
 * The sweep (core-service only, `crm.phoneReservationIntervalMs`):
 * - a deal marked lost gives its numbers back (`deal_lost`);
 * - a hold past its date is marked expired and the owner told;
 * - the owner is warned `warn_days` before (the `phone.reservation` rule,
 *   CD-53), once per expiry date — extending is a fresh warning.
 */
@Injectable()
export class PhoneReservationsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PhoneReservationsService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly opportunities: OpportunityRepository,
    private readonly reservations: OpportunityPhoneReservationRepository,
    private readonly companies: CompanyRepository,
    private readonly members: CompanyMemberRepository,
    private readonly rules: NotificationRulesService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditWriter,
    private readonly config: ConfigService,
    @Inject(RESERVE_PHONE_CLIENT) private readonly client: ReservePhoneClient,
  ) {}

  onModuleInit(): void {
    const interval =
      this.config.get<number>('crm.phoneReservationIntervalMs') ??
      DEFAULT_INTERVAL_MS;
    if (interval <= 0) return;
    this.timer = setInterval(
      backgroundTick(this.logger, 'CD-78 phone reservations', () =>
        this.sweep(),
      ),
      interval,
    );
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private get holdDays(): number {
    return this.config.get<number>('reservePhone.holdDays') ?? 14;
  }

  private get maxHoldDays(): number {
    return this.config.get<number>('reservePhone.maxHoldDays') ?? 60;
  }

  // --- the deal page -------------------------------------------------------

  /** The deal's holds — live first — and the hold lengths the form offers. */
  async list(id: string, actor: Principal) {
    await this.requireVisible(id, actor);
    const rows = (await this.reservations.findMany({
      where: { opportunityId: id },
      orderBy: [{ createdAt: 'desc' }],
    })) as unknown as (ReservationRow & Record<string, unknown>)[];
    const names = await this.displayNames(
      rows.flatMap((row) => [row.createdBy, row.releasedBy as string | null]),
    );
    const order = { reserved: 0, expired: 1, released: 2 } as const;
    return {
      mode: this.client.mode,
      holdDays: this.holdDays,
      maxHoldDays: this.maxHoldDays,
      reservations: rows
        .sort((a, b) => order[a.status] - order[b.status])
        .map((row) => ({
          ...row,
          createdByName: names.get(row.createdBy) ?? row.createdBy,
          releasedByName: row.releasedBy
            ? (names.get(row.releasedBy as string) ?? row.releasedBy)
            : null,
        })),
    };
  }

  /** Free numbers, asked of Reserve-phone live. */
  async search(
    id: string,
    query: SearchPhoneNumbersQueryDto,
    actor: Principal,
  ) {
    const deal = await this.requireOpen(id, actor);
    const ctx = await this.contextOf(deal.companyId);
    try {
      const numbers = await this.client.search(ctx, {
        contains: query.contains,
        prefix: query.prefix,
        category: query.category,
        limit: SEARCH_LIMIT,
      });
      return { mode: this.client.mode, numbers };
    } catch (error) {
      throw this.unreachable(error);
    }
  }

  /**
   * Hold each number for the deal. Numbers are independent: one that was
   * taken meanwhile is reported in `failed` and the rest are still held.
   */
  async reserve(id: string, dto: ReservePhoneNumbersDto, actor: Principal) {
    const deal = await this.requireOpen(id, actor);
    const days = dto.hold_days ?? this.holdDays;
    this.assertHoldDays(days);
    const ctx = await this.contextOf(deal.companyId);
    const expiresAt = new Date(Date.now() + days * DAY_MS).toISOString();

    const reserved: ReservationRow[] = [];
    const failed: { number: string; reason: string }[] = [];
    for (const number of [...new Set(dto.numbers)]) {
      const heldHere = (await this.reservations.findFirst({
        where: { companyId: deal.companyId, number, status: 'reserved' },
        select: { opportunity: { select: { opportunityCode: true } } },
      })) as { opportunity: { opportunityCode: string } } | null;
      if (heldHere) {
        failed.push({
          number,
          reason: `จองไว้แล้วให้ ${heldHere.opportunity.opportunityCode}`,
        });
        continue;
      }

      let hold: PhoneReservation;
      try {
        hold = await this.client.reserve(ctx, number, {
          reference: deal.opportunityCode,
          expiresAt,
        });
      } catch (error) {
        if (error instanceof PhoneNumberUnavailableError) {
          failed.push({ number, reason: 'เบอร์นี้ไม่ว่างแล้ว' });
          continue;
        }
        // Reserve-phone down: stop here, keep what was already held.
        if (!reserved.length) throw this.unreachable(error);
        failed.push({ number, reason: 'ติดต่อ Reserve-phone ไม่ได้' });
        break;
      }

      try {
        const row = (await this.reservations.create({
          data: {
            companyId: deal.companyId,
            opportunityId: deal.id,
            number: hold.number,
            category: hold.category,
            fee: hold.fee,
            externalReservationId: hold.reservationId,
            expiresAt: new Date(hold.expiresAt),
            createdBy: actor.userId,
          },
        })) as unknown as ReservationRow;
        reserved.push(row);
      } catch (error) {
        // Never leave a hold no deal records — give it straight back.
        await this.client
          .release(ctx, hold.reservationId)
          .catch(() => undefined);
        if (!isUniqueViolation(error)) throw error;
        failed.push({ number, reason: 'จองไว้แล้วให้ดีลอื่น' });
        continue;
      }

      await this.audit.record({
        eventType: 'crm.opportunity.phone_reserved',
        companyId: deal.companyId,
        ...auditActor(actor),
        resourceType: 'opportunity',
        resourceId: deal.id,
        after: {
          number: hold.number,
          reservationId: hold.reservationId,
          expiresAt: hold.expiresAt,
        },
      });
    }
    return { reserved, failed };
  }

  /** Push a live hold out to `hold_days` from today. */
  async extend(
    id: string,
    reservationId: string,
    dto: ExtendPhoneReservationDto,
    actor: Principal,
  ) {
    const deal = await this.requireOpen(id, actor);
    this.assertHoldDays(dto.hold_days);
    const row = await this.requireLive(deal.id, reservationId);
    const ctx = await this.contextOf(deal.companyId);
    const target = new Date(Date.now() + dto.hold_days * DAY_MS).toISOString();
    let answer: { expiresAt: string };
    try {
      answer = await this.client.extend(ctx, row.externalReservationId, target);
    } catch (error) {
      throw this.unreachable(error);
    }
    const updated = await this.reservations.update({
      where: { id: row.id },
      data: { expiresAt: new Date(answer.expiresAt), expiryWarnedFor: null },
    });
    await this.audit.record({
      eventType: 'crm.opportunity.phone_extended',
      companyId: deal.companyId,
      ...auditActor(actor),
      resourceType: 'opportunity',
      resourceId: deal.id,
      before: { number: row.number, expiresAt: row.expiresAt.toISOString() },
      after: { number: row.number, expiresAt: answer.expiresAt },
    });
    return updated;
  }

  /** Give a number back. Allowed on a closed deal too — a won deal may drop one. */
  async release(id: string, reservationId: string, actor: Principal) {
    const deal = await this.requireVisible(id, actor);
    const row = await this.requireLive(deal.id, reservationId);
    const ctx = await this.contextOf(deal.companyId);
    try {
      await this.client.release(ctx, row.externalReservationId);
    } catch (error) {
      throw this.unreachable(error);
    }
    const updated = await this.reservations.update({
      where: { id: row.id },
      data: {
        status: 'released',
        releasedAt: new Date(),
        releasedBy: actor.userId,
        releaseReason: 'manual',
      },
    });
    await this.audit.record({
      eventType: 'crm.opportunity.phone_released',
      companyId: deal.companyId,
      ...auditActor(actor),
      resourceType: 'opportunity',
      resourceId: deal.id,
      before: { number: row.number, status: 'reserved' },
      after: { number: row.number, status: 'released', reason: 'manual' },
    });
    return updated;
  }

  // --- the sweep -----------------------------------------------------------

  async sweep(
    now: Date = new Date(),
  ): Promise<{ released: number; expired: number; warned: number }> {
    const released = await this.releaseLostDeals(now);
    const rule = await this.rules.across('phone.reservation');
    const expired = await this.expire(now, rule);
    const warned = await this.warn(now, rule);
    if (released || expired || warned) {
      this.logger.log(
        `CD-78: released ${released} · expired ${expired} · warned ${warned}`,
      );
    }
    return { released, expired, warned };
  }

  private async releaseLostDeals(now: Date): Promise<number> {
    const rows = (await this.reservations.findMany({
      where: { status: 'reserved', opportunity: { stage: 'lost' } },
      take: 200,
    })) as unknown as ReservationRow[];
    let count = 0;
    for (const row of rows) {
      try {
        const ctx = await this.contextOf(row.companyId);
        await this.client.release(ctx, row.externalReservationId);
      } catch (error) {
        // Reserve-phone down — the next tick tries again.
        this.logger.warn(
          `CD-78: release ${row.number} failed: ${(error as Error).message}`,
        );
        continue;
      }
      const claimed = await this.reservations.updateMany({
        where: { id: row.id, status: 'reserved' },
        data: {
          status: 'released',
          releasedAt: now,
          releaseReason: 'deal_lost',
        },
      });
      count += claimed.count;
    }
    return count;
  }

  private async expire(
    now: Date,
    rule: Awaited<ReturnType<NotificationRulesService['across']>>,
  ): Promise<number> {
    const rows = (await this.reservations.findMany({
      where: { status: 'reserved', expiresAt: { lte: now } },
      include: { opportunity: { select: DEAL_SELECT } },
      take: 500,
    })) as unknown as (ReservationRow & { opportunity: ReservationDeal })[];
    let count = 0;
    for (const row of rows) {
      // Guarded on the status read: an overlapping tick expires nothing twice.
      const claimed = await this.reservations.updateMany({
        where: { id: row.id, status: 'reserved' },
        data: { status: 'expired' },
      });
      if (claimed.count !== 1) continue;
      count += 1;
      if (!rule.of(row.companyId).enabled) continue;
      if (['won', 'lost'].includes(row.opportunity.stage)) continue;
      await this.notifications.phoneReservationExpiry(
        row.opportunity.ownerUserId,
        row.companyId,
        row.opportunity,
        { number: row.number, expiresOn: bangkokDay(row.expiresAt) },
        true,
      );
    }
    return count;
  }

  private async warn(
    now: Date,
    rule: Awaited<ReturnType<NotificationRulesService['across']>>,
  ): Promise<number> {
    const enabled = [rule.standard, ...rule.byCompany.values()].filter(
      (one) => one.enabled,
    );
    if (!enabled.length) return 0;
    const widest = Math.max(
      ...enabled.map((one) => one.params.warn_days as number),
    );
    const rows = (await this.reservations.findMany({
      where: {
        status: 'reserved',
        expiresAt: { gt: now, lte: new Date(now.getTime() + widest * DAY_MS) },
        opportunity: { stage: { notIn: ['won', 'lost'] } },
      },
      include: { opportunity: { select: DEAL_SELECT } },
      take: 500,
    })) as unknown as (ReservationRow & { opportunity: ReservationDeal })[];
    let count = 0;
    for (const row of rows) {
      const own = rule.of(row.companyId);
      if (!own.enabled) continue;
      if (row.expiryWarnedFor?.getTime() === row.expiresAt.getTime()) continue;
      const warnDays = own.params.warn_days as number;
      if (row.expiresAt.getTime() - now.getTime() > warnDays * DAY_MS) continue;
      const claimed = await this.reservations.updateMany({
        where: { id: row.id, expiryWarnedFor: row.expiryWarnedFor },
        data: { expiryWarnedFor: row.expiresAt },
      });
      if (claimed.count !== 1) continue;
      await this.notifications.phoneReservationExpiry(
        row.opportunity.ownerUserId,
        row.companyId,
        row.opportunity,
        { number: row.number, expiresOn: bangkokDay(row.expiresAt) },
        false,
      );
      count += 1;
    }
    return count;
  }

  // --- helpers -------------------------------------------------------------

  private assertHoldDays(days: number) {
    if (days > this.maxHoldDays) {
      throw new AppError(
        'VALIDATION_FAILED',
        `จองได้นานสุด ${this.maxHoldDays} วัน`,
        [{ field: 'hold_days', reason: String(days) }],
      );
    }
  }

  private async contextOf(companyId: string): Promise<ReservePhoneContext> {
    const company = (await this.companies.findFirst({
      where: { id: companyId },
      select: { code: true },
    })) as { code: string } | null;
    if (!company) throw new AppError('NOT_FOUND', 'ไม่พบบริษัท');
    return { companyCode: company.code };
  }

  private unreachable(error: unknown): AppError {
    this.logger.warn(`CD-78: Reserve-phone: ${(error as Error)?.message}`);
    return new AppError(
      'UPSTREAM_ERROR',
      'ติดต่อระบบ Reserve-phone ไม่ได้ในขณะนี้ กรุณาลองใหม่',
    );
  }

  private async requireLive(
    opportunityId: string,
    reservationId: string,
  ): Promise<ReservationRow> {
    const row = (await this.reservations.findFirst({
      where: { id: reservationId, opportunityId },
    })) as ReservationRow | null;
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบการจองเบอร์นี้');
    if (row.status !== 'reserved') {
      throw new AppError('CONFLICT', 'การจองนี้ปล่อยหรือหมดอายุไปแล้ว');
    }
    return row;
  }

  private async requireVisible(
    id: string,
    actor: Principal,
  ): Promise<ReservationDeal> {
    const found = (await this.opportunities.findFirst({
      where: { id, AND: [visibleSalesWhere(salesAccessSubject(actor))] },
      select: DEAL_SELECT,
    })) as ReservationDeal | null;
    // SCOPE-03: out of reach answers 404.
    if (!found) throw new AppError('NOT_FOUND', 'ไม่พบโอกาสการขายที่ระบุ');
    return found;
  }

  private async requireOpen(
    id: string,
    actor: Principal,
  ): Promise<ReservationDeal> {
    const found = await this.requireVisible(id, actor);
    if (found.stage === 'won' || found.stage === 'lost') {
      throw new AppError(
        'CONFLICT',
        'โอกาสการขายนี้ปิดแล้ว — จองหรือต่ออายุเบอร์ไม่ได้',
      );
    }
    return found;
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

const DEAL_SELECT = {
  id: true,
  companyId: true,
  opportunityCode: true,
  title: true,
  stage: true,
  ownerUserId: true,
} as const;
