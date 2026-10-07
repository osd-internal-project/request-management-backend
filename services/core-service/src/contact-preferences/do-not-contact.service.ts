import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  AppError,
  AuditWriter,
  auditActor,
  paginated,
  PrismaTransactionService,
  toSkipTake,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import {
  blocks,
  type ContactKind,
  normalizeContact,
  normalizeEmail,
  normalizePhone,
  type OptOutChannel,
  type OptOutSource,
} from './contact-rules';
import { DoNotContactRepository } from './contact-preferences.repositories';
import { ListOptOutsQueryDto } from './contact-preferences.dto';

interface EntryRow {
  id: string;
  companyId: string;
  kind: string;
  value: string;
  channel: string;
  reason: string | null;
  source: string;
  sourceRef: string | null;
  createdBy: string | null;
  createdAt: Date;
  removedAt: Date | null;
  removedBy: string | null;
  removeReason: string | null;
}

export interface OptOutInput {
  kind: ContactKind;
  value: string;
  channel: OptOutChannel;
  reason?: string | null;
  source: OptOutSource;
  sourceRef?: string | null;
}

/**
 * CD-291 — the do-not-contact register, one per company, read by every
 * channel that reaches people on the company's behalf: AI SMART before each
 * call, AI CARE before a message. It stands in for the PDPA central system
 * until that exists, and then the central system syncs into it (`pdpa`).
 *
 * An entry is never deleted. Lifting one records who and why; the refusal
 * and its lifting both stay in the audit log.
 */
@Injectable()
export class DoNotContactService {
  constructor(
    private readonly entries: DoNotContactRepository,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
  ) {}

  /** The active entry that stops this contact on `channel`, if any. */
  async blockFor(
    companyId: string,
    contact: { phone?: string | null; email?: string | null },
    channel: 'call' | 'message',
  ): Promise<EntryRow | null> {
    const phone = normalizePhone(contact.phone);
    const email = normalizeEmail(contact.email);
    if (!phone && !email) return null;
    const rows = (await this.entries.findMany({
      where: {
        companyId,
        removedAt: null,
        OR: [
          ...(phone ? [{ kind: 'phone', value: phone }] : []),
          ...(email ? [{ kind: 'email', value: email }] : []),
        ],
      },
      orderBy: { createdAt: 'asc' },
    })) as EntryRow[];
    return rows.find((row) => blocks(row.channel, channel)) ?? null;
  }

  /** Of these phones, the ones that may not be called. */
  async blockedPhones(
    companyId: string,
    phones: string[],
  ): Promise<Set<string>> {
    const wanted = [
      ...new Set(phones.flatMap((phone) => normalizePhone(phone) ?? [])),
    ];
    if (!wanted.length) return new Set();
    const rows = (await this.entries.findMany({
      where: {
        companyId,
        removedAt: null,
        kind: 'phone',
        value: { in: wanted },
      },
      select: { value: true, channel: true },
    })) as { value: string; channel: string }[];
    return new Set(
      rows.filter((row) => blocks(row.channel, 'call')).map((row) => row.value),
    );
  }

  /**
   * Adds an entry; an identical active one is returned instead of a second.
   * `actor` is null when the system records a refusal heard on a call.
   */
  async add(companyId: string, input: OptOutInput, actor: Principal | null) {
    const value = normalizeContact(input.kind, input.value);
    if (!value) {
      throw new AppError(
        'VALIDATION_FAILED',
        input.kind === 'phone' ? 'เบอร์โทรไม่ถูกต้อง' : 'อีเมลไม่ถูกต้อง',
        [{ field: 'value', reason: 'invalid' }],
      );
    }
    const existing = await this.entries.findFirst({
      where: { companyId, kind: input.kind, value, removedAt: null },
    });
    if (
      existing &&
      (existing.channel === 'all' || existing.channel === input.channel)
    ) {
      return this.view(existing);
    }
    const created = await this.transactions.execute(async (prisma) => {
      const row = await this.entries.create(
        {
          data: {
            companyId,
            kind: input.kind,
            value,
            channel: input.channel,
            reason: input.reason ?? null,
            source: input.source,
            sourceRef: input.sourceRef ?? null,
            createdBy: actor?.userId ?? null,
          },
        },
        { prisma },
      );
      await this.audit.record(
        {
          eventType: 'contact.optout.added',
          companyId,
          ...(actor
            ? auditActor(actor)
            : { actorId: null, actorUsername: 'system:ai-smart' }),
          resourceType: 'do_not_contact',
          resourceId: row.id,
          after: {
            kind: input.kind,
            channel: input.channel,
            source: input.source,
            sourceRef: input.sourceRef ?? null,
          },
        },
        { prisma },
      );
      return row;
    });
    return this.view(created);
  }

  async remove(actor: Principal, id: string, reason: string) {
    const row = await this.entries.findFirst({
      where: { id, companyId: actor.activeCompanyId },
    });
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบรายการในทะเบียนห้ามติดต่อ');
    if (row.removedAt)
      throw new AppError('CONFLICT', 'รายการนี้ถูกยกเลิกไปแล้ว');
    const updated = await this.transactions.execute(async (prisma) => {
      const next = await this.entries.update(
        {
          where: { id },
          data: {
            removedAt: new Date(),
            removedBy: actor.userId,
            removeReason: reason,
          },
        },
        { prisma },
      );
      await this.audit.record(
        {
          eventType: 'contact.optout.removed',
          companyId: actor.activeCompanyId,
          ...auditActor(actor),
          resourceType: 'do_not_contact',
          resourceId: id,
          before: { removedAt: null },
          after: { removedAt: next.removedAt, reason },
        },
        { prisma },
      );
      return next;
    });
    return this.view(updated);
  }

  async list(actor: Principal, query: ListOptOutsQueryDto) {
    const where: Prisma.DoNotContactWhereInput = {
      companyId: actor.activeCompanyId,
      ...(query.active === 'false' ? {} : { removedAt: null }),
      ...(query.source ? { source: query.source } : {}),
    };
    const q = query.q?.trim();
    if (q) {
      const phone = normalizePhone(q);
      where.value = phone ?? { contains: q.toLowerCase() };
    }
    const { skip, take } = toSkipTake(query);
    const [rows, total] = await Promise.all([
      this.entries.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }) as Promise<EntryRow[]>,
      this.entries.count({ where }),
    ]);
    return paginated(
      rows.map((row) => this.view(row)),
      query,
      total,
    );
  }

  private view(row: EntryRow) {
    return {
      id: row.id,
      kind: row.kind,
      value: row.value,
      channel: row.channel,
      reason: row.reason,
      source: row.source,
      source_ref: row.sourceRef,
      created_at: row.createdAt,
      removed_at: row.removedAt,
      remove_reason: row.removeReason,
    };
  }
}
