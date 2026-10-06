import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AppError,
  AuditWriter,
  hasPermission,
  type Principal,
} from '@request-management/share';
import { backgroundTick } from '../common/background-tick';
import { EntitlementsService } from '../support/entitlements.service';
import { ServiceAssetRepository } from '../support/support.repositories';
import {
  CARE_STATUSES,
  DEFAULT_IDLE_HOURS,
  DEFAULT_RETENTION_DAYS,
  MAX_TEXT,
  claimsIn,
  continues,
  emailKey,
  mergeClaims,
  onlyCustomer,
  phoneKey,
  platformField,
  stronger,
  type CareChannel,
  type Claims,
  type Identification,
} from './care-rules';
import { CareAnswerService } from './care-answer.service';
import {
  CareContactLookupRepository,
  CareConversationRepository,
  CareIdentityRepository,
  CareMessageRepository,
  type ContactMatch,
} from './care.repositories';

const MANAGE = 'service.care.manage';
const SWEEP_MS = 15 * 60 * 1000;
/** Messages a channel or AI gets back as the conversation so far. */
const HISTORY = 20;

export interface ConversationRow {
  id: string;
  companyId: string;
  channel: string;
  senderRef: string;
  senderName: string | null;
  identification: string;
  customerId: string | null;
  contactId: string | null;
  verifiedAt: Date | null;
  verifiedBy: string | null;
  verifyMethod: string | null;
  status: string;
  outcome: string | null;
  messages: number;
  openedAt: Date;
  lastMessageAt: Date;
  closedAt: Date | null;
  closedBy: string | null;
  textPurgedAt: Date | null;
}

interface MessageRow {
  id: string;
  direction: string;
  author: string;
  authorUserId: string | null;
  text: string | null;
  attachments: unknown;
  kbQueryId: string | null;
  createdAt: Date;
}

export interface Attachment {
  name: string;
  type?: string;
  url?: string;
}

export interface InboundMessage {
  channel: CareChannel;
  senderRef: string;
  senderName?: string;
  text?: string;
  attachments?: Attachment[];
  /** What the connector or AI already read out of the message. */
  claimed?: { phone?: string; email?: string; customerCode?: string };
  /** When the channel received it (defaults to now). */
  at?: Date;
}

/**
 * CD-280 (CD-23 AI CARE) — every customer conversation, whichever channel it
 * comes through: a sender's messages join their open conversation; the
 * sender is recognised from the identity the platform gives (LINE id, email
 * sender, caller number) or a channel identity confirmed before — then
 * assets and coverage come with the conversation. A phone, email or customer
 * code typed in the chat only *claims* a customer: general answers only,
 * until a staff member confirms it. Texts are cleared after the retention
 * period; the conversation, its outcome and counts stay.
 */
@Injectable()
export class CareService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CareService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly conversations: CareConversationRepository,
    private readonly messages: CareMessageRepository,
    private readonly identities: CareIdentityRepository,
    private readonly lookup: CareContactLookupRepository,
    private readonly assets: ServiceAssetRepository,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditWriter,
    private readonly config: ConfigService,
    private readonly answers: CareAnswerService,
  ) {}

  onModuleInit(): void {
    const interval =
      this.config.get<number>('care.sweepIntervalMs') ?? SWEEP_MS;
    if (interval <= 0) return;
    this.timer = setInterval(
      backgroundTick(this.logger, 'care sweep', () => this.sweep()),
      interval,
    );
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private idleHours() {
    return this.config.get<number>('care.idleHours') || DEFAULT_IDLE_HOURS;
  }

  private retentionDays() {
    return (
      this.config.get<number>('care.retentionDays') || DEFAULT_RETENTION_DAYS
    );
  }

  // --- channels (robots) --------------------------------------------------------

  /** A customer's message: into their conversation, which comes back with context. */
  async receive(companyId: string, input: InboundMessage) {
    const senderRef = input.senderRef.trim().slice(0, 200);
    if (!senderRef) throw new AppError('VALIDATION_FAILED', 'ต้องระบุผู้ส่ง');
    const text = input.text?.trim().slice(0, MAX_TEXT) || null;
    const attachments = (input.attachments ?? []).slice(0, 20);
    if (!text && !attachments.length)
      throw new AppError('VALIDATION_FAILED', 'ข้อความว่าง');
    const at = input.at ?? new Date();

    let conversation = await this.current(companyId, input.channel, senderRef);
    let isNew = false;
    if (!conversation || !continues(conversation, at, this.idleHours())) {
      if (conversation && conversation.status !== 'closed')
        await this.end(conversation.id, 'idle', null, at);
      conversation = await this.conversations.create({
        data: {
          companyId,
          channel: input.channel,
          senderRef,
          senderName: input.senderName?.trim().slice(0, 200) || null,
          openedAt: at,
          lastMessageAt: at,
        },
      });
      isNew = true;
    }

    conversation = await this.identify(
      conversation,
      mergeClaims(claimsIn(text), {
        phones: [phoneKey(input.claimed?.phone)].filter(Boolean) as string[],
        emails: [emailKey(input.claimed?.email)].filter(Boolean) as string[],
        customerCodes: input.claimed?.customerCode
          ? [input.claimed.customerCode.trim().toUpperCase()]
          : [],
      }),
    );

    await this.messages.create({
      data: {
        conversationId: conversation.id,
        direction: 'in',
        author: 'customer',
        text,
        attachments: attachments as object[],
        createdAt: at,
      },
    });
    conversation = await this.conversations.update({
      where: { id: conversation.id },
      data: {
        messages: { increment: 1 },
        lastMessageAt: at,
        ...(input.senderName && !conversation.senderName
          ? { senderName: input.senderName.trim().slice(0, 200) }
          : {}),
      },
    });
    const context = await this.context(conversation);
    // CD-281 — AI CARE answers while it is handling the conversation
    const reply =
      conversation.status === 'open' && text && this.autoReply()
        ? await this.answerFor(conversation, context)
        : null;
    if (reply) {
      const sent = (await this.messages.create({
        data: {
          conversationId: conversation.id,
          direction: 'out',
          author: 'ai',
          text: reply.text,
          kbQueryId: reply.kbQueryId,
        },
      })) as MessageRow;
      await this.conversations.update({
        where: { id: conversation.id },
        data: { messages: { increment: 1 }, lastMessageAt: new Date() },
      });
      context.history.push(this.message(sent));
      context.conversation.messages += 1;
    }
    return { isNew, ...context, reply };
  }

  /** CARE_AUTO_REPLY=off — a connector with its own AI answers (and posts replies). */
  private autoReply() {
    return this.config.get<boolean>('care.autoReply') ?? true;
  }

  /** The customer's latest words (since the last answer) asked of the knowledge base. */
  private async answerFor(
    conversation: ConversationRow,
    context: Awaited<ReturnType<CareService['context']>>,
  ) {
    const history = context.history;
    let start = history.length;
    while (start > 0 && history[start - 1].direction === 'in') start -= 1;
    const question = history
      .slice(start)
      .map((m) => m.text)
      .filter(Boolean)
      .join('\n');
    if (!question) return null;
    return this.answers.answer({
      companyId: conversation.companyId,
      conversationId: conversation.id,
      question,
      // customer-specific articles and equipment only for a verified sender
      customerCode: context.customer?.code ?? null,
      customerName: context.customer?.name ?? null,
      assets: context.assets.map((a) => ({
        name: a.name,
        model: a.model,
        coverage: a.coverage
          ? { title: a.coverage.title, endOn: a.coverage.endOn }
          : null,
      })),
      history: history.slice(0, start),
    });
  }

  /** What was answered (AI, or a system notice) — recorded in the conversation. */
  async reply(
    companyId: string,
    id: string,
    input: { text: string; author?: 'ai' | 'system'; kbQueryId?: string },
  ) {
    const conversation = await this.mine(companyId, id);
    if (conversation.status === 'closed')
      throw new AppError('CONFLICT', 'บทสนทนานี้ปิดแล้ว');
    const text = input.text.trim().slice(0, MAX_TEXT);
    if (!text) throw new AppError('VALIDATION_FAILED', 'ข้อความว่าง');
    const message = (await this.messages.create({
      data: {
        conversationId: id,
        direction: 'out',
        author: input.author ?? 'ai',
        text,
        kbQueryId: input.kbQueryId ?? null,
      },
    })) as MessageRow;
    await this.conversations.update({
      where: { id },
      data: { messages: { increment: 1 }, lastMessageAt: new Date() },
    });
    return { id: message.id };
  }

  /** The conversation for a channel or AI: history, and context once verified. */
  async forChannel(companyId: string, id: string) {
    return this.context(await this.mine(companyId, id));
  }

  // --- staff ------------------------------------------------------------------------

  async list(
    actor: Principal,
    filter: {
      status?: string;
      channel?: string;
      customerId?: string;
      identification?: string;
    },
  ) {
    this.manage(actor);
    const statuses =
      filter.status === 'live'
        ? ['open', 'waiting_human', 'with_agent']
        : filter.status &&
            (CARE_STATUSES as readonly string[]).includes(filter.status)
          ? [filter.status]
          : undefined;
    const rows = (await this.conversations.findMany({
      where: {
        companyId: actor.activeCompanyId,
        ...(statuses ? { status: { in: statuses } } : {}),
        ...(filter.channel ? { channel: filter.channel } : {}),
        ...(filter.customerId ? { customerId: filter.customerId } : {}),
        ...(filter.identification
          ? { identification: filter.identification }
          : {}),
      },
      orderBy: [{ lastMessageAt: 'desc' }],
      take: 200,
    })) as ConversationRow[];
    const customers = new Map<string, { code: string; name: string }>();
    for (const id of new Set(rows.map((r) => r.customerId).filter(Boolean))) {
      const c = await this.lookup.customer(id!);
      if (c) customers.set(c.id, { code: c.customerCode, name: c.nameTh });
    }
    const last = await this.lastTexts(rows.map((r) => r.id));
    return rows.map((r) => ({
      ...this.view(r),
      customer: r.customerId ? (customers.get(r.customerId) ?? null) : null,
      lastText: last.get(r.id) ?? null,
    }));
  }

  async detail(actor: Principal, id: string) {
    this.manage(actor);
    const conversation = await this.mine(actor.activeCompanyId, id);
    const [context, messages, contacts] = await Promise.all([
      this.context(conversation, { staff: true }),
      this.messages.findMany({
        where: { conversationId: id },
        orderBy: [{ createdAt: 'asc' }],
        take: 1000,
      }) as Promise<MessageRow[]>,
      conversation.customerId
        ? this.lookup.contacts(conversation.customerId)
        : Promise.resolve([]),
    ]);
    return {
      ...context,
      messages: messages.map((m) => this.message(m)),
      // whom a staff member may confirm the sender as
      contacts,
    };
  }

  /** The contacts of a customer, to confirm a sender against. */
  async contactsOf(actor: Principal, customerId: string) {
    this.manage(actor);
    const customer = await this.lookup.customer(customerId);
    if (!customer || customer.companyId !== actor.activeCompanyId)
      throw new AppError('NOT_FOUND', 'ไม่พบลูกค้า');
    return this.lookup.contacts(customerId);
  }

  /** A staff member confirms who the sender is — remembered for next time. */
  async verify(actor: Principal, id: string, contactId: string) {
    this.manage(actor);
    const conversation = await this.mine(actor.activeCompanyId, id);
    const owner = await this.contactOwner(actor.activeCompanyId, contactId);
    await this.conversations.update({
      where: { id },
      data: {
        identification: 'verified',
        customerId: owner.customerId,
        contactId: owner.id,
        verifiedAt: new Date(),
        verifiedBy: actor.userId,
        verifyMethod: 'staff',
      },
    });
    await this.remember(conversation, owner, 'staff', actor.userId);
    await this.audit.record({
      eventType: 'care.sender.verified',
      companyId: actor.activeCompanyId,
      actorId: actor.userId,
      actorUsername: actor.username,
      resourceType: 'care_conversation',
      resourceId: id,
      after: { contactId: owner.id, customerId: owner.customerId },
    });
    return this.detail(actor, id);
  }

  async close(actor: Principal, id: string, outcome: string) {
    this.manage(actor);
    const conversation = await this.mine(actor.activeCompanyId, id);
    if (conversation.status === 'closed')
      throw new AppError('CONFLICT', 'บทสนทนานี้ปิดแล้ว');
    await this.end(id, outcome, actor.userId, new Date());
    return this.detail(actor, id);
  }

  // --- the sweep ------------------------------------------------------------------

  /** Close conversations AI was handling that went quiet; clear old texts. */
  async sweep(now = new Date()) {
    const idleBefore = new Date(now.getTime() - this.idleHours() * 3600_000);
    const idle = (await this.conversations.findMany({
      where: { status: 'open', lastMessageAt: { lt: idleBefore } },
      select: { id: true },
      take: 1000,
    })) as { id: string }[];
    for (const row of idle) await this.end(row.id, 'idle', null, now);
    const purgeBefore = new Date(
      now.getTime() - this.retentionDays() * 86_400_000,
    );
    const purged = await this.messages.purge(purgeBefore);
    return { closed: idle.length, purged };
  }

  // --- inside -----------------------------------------------------------------------

  private async current(companyId: string, channel: string, senderRef: string) {
    return (await this.conversations.findFirst({
      where: { companyId, channel, senderRef },
      orderBy: [{ openedAt: 'desc' }],
    })) as ConversationRow | null;
  }

  /**
   * Who the sender is: a confirmed channel identity, else the platform's
   * identity matching one customer's contact (verified), else what they
   * typed matching one customer (claimed).
   */
  private async identify(
    conversation: ConversationRow,
    claims: Claims,
  ): Promise<ConversationRow> {
    if (conversation.identification === 'verified') return conversation;
    const { companyId, channel, senderRef } = conversation;
    const known = (await this.identities.findFirst({
      where: { companyId, channel, senderRef },
    })) as { customerId: string; contactId: string; method: string } | null;
    if (known) {
      return this.mark(conversation, 'verified', {
        customerId: known.customerId,
        contactId: known.contactId,
        method: `remembered:${known.method}`,
      });
    }
    const field = platformField(channel as CareChannel);
    if (field) {
      const value =
        field === 'phone'
          ? phoneKey(senderRef)
          : field === 'email'
            ? emailKey(senderRef)
            : senderRef;
      const match = value
        ? onlyCustomer(await this.lookup.byField(companyId, field, [value]))
        : null;
      if (match) {
        await this.remember(conversation, match, 'channel', null);
        return this.mark(conversation, 'verified', {
          customerId: match.customerId,
          contactId: match.id,
          method: 'channel',
        });
      }
    }
    if (conversation.identification === 'claimed') return conversation;
    const typed = [
      ...(await this.lookup.byField(companyId, 'phone', claims.phones)),
      ...(await this.lookup.byField(companyId, 'email', claims.emails)),
      ...(
        await this.lookup.customersByCode(companyId, claims.customerCodes)
      ).map((c) => ({ id: '', customerId: c.id, name: '' })),
    ];
    const claimed = onlyCustomer(typed);
    if (!claimed) return conversation;
    return this.mark(conversation, 'claimed', {
      customerId: claimed.customerId,
      contactId: claimed.id || null,
      method: 'typed',
    });
  }

  private async mark(
    conversation: ConversationRow,
    identification: Identification,
    who: { customerId: string; contactId: string | null; method: string },
  ) {
    if (
      !stronger(conversation.identification as Identification, identification)
    )
      return conversation;
    return (await this.conversations.update({
      where: { id: conversation.id },
      data: {
        identification,
        customerId: who.customerId,
        contactId: who.contactId,
        verifyMethod: who.method,
        ...(identification === 'verified' ? { verifiedAt: new Date() } : {}),
      },
    })) as ConversationRow;
  }

  private async remember(
    conversation: Pick<ConversationRow, 'companyId' | 'channel' | 'senderRef'>,
    contact: Pick<ContactMatch, 'id' | 'customerId'>,
    method: string,
    by: string | null,
  ) {
    const key = {
      companyId: conversation.companyId,
      channel: conversation.channel,
      senderRef: conversation.senderRef,
    };
    await this.identities.upsert({
      where: { companyId_channel_senderRef: key },
      create: {
        ...key,
        customerId: contact.customerId,
        contactId: contact.id,
        method,
        verifiedBy: by,
      },
      update: {
        customerId: contact.customerId,
        contactId: contact.id,
        method,
        verifiedBy: by,
      },
    });
  }

  private async contactOwner(companyId: string, contactId: string) {
    const contact = await this.lookup.contact(contactId);
    const customer = contact
      ? await this.lookup.customer(contact.customerId)
      : null;
    if (!contact || !customer || customer.companyId !== companyId)
      throw new AppError('NOT_FOUND', 'ไม่พบผู้ติดต่อ');
    return { id: contact.id, customerId: customer.id };
  }

  private async end(id: string, outcome: string, by: string | null, at: Date) {
    await this.conversations.update({
      where: { id },
      data: { status: 'closed', outcome, closedAt: at, closedBy: by },
    });
  }

  /** The conversation as a channel, AI or staff member gets it. */
  private async context(
    conversation: ConversationRow,
    options: { staff?: boolean } = {},
  ) {
    const verified = conversation.identification === 'verified';
    const showCustomer = verified || options.staff;
    const customer =
      showCustomer && conversation.customerId
        ? await this.lookup.customer(conversation.customerId)
        : null;
    const contact =
      showCustomer && conversation.contactId
        ? await this.lookup.contact(conversation.contactId)
        : null;
    const history = (await this.messages.findMany({
      where: { conversationId: conversation.id },
      orderBy: [{ createdAt: 'desc' }],
      take: HISTORY,
    })) as MessageRow[];
    return {
      conversation: this.view(conversation),
      customer: customer
        ? {
            id: customer.id,
            code: customer.customerCode,
            name: customer.nameTh,
          }
        : null,
      contact: contact ? { id: contact.id, name: contact.name } : null,
      // assets and coverage only for a verified sender
      ...(verified && customer
        ? await this.equipment(conversation.companyId, customer.id)
        : { assets: [], entitlements: [] }),
      history: history.reverse().map((m) => this.message(m)),
    };
  }

  /** What the customer has installed, each with the coverage in force today. */
  private async equipment(companyId: string, customerId: string) {
    const rows = (await this.assets.findMany({
      where: { companyId, customerId, status: 'active' },
      orderBy: [{ name: 'asc' }],
      select: {
        id: true,
        kind: true,
        name: true,
        model: true,
        serialNo: true,
        location: true,
      },
      take: 200,
    })) as {
      id: string;
      kind: string;
      name: string;
      model: string | null;
      serialNo: string | null;
      location: string | null;
    }[];
    const coverage = await this.entitlements.forAssets(
      companyId,
      rows.map((r) => r.id),
    );
    const entitlements = new Map<
      string,
      {
        id: string;
        title: string;
        kind: string;
        endOn: string;
        state: string;
        coverage: string | null;
      }
    >();
    for (const c of coverage.values())
      for (const e of c.all)
        if (!entitlements.has(e.id))
          entitlements.set(e.id, {
            id: e.id,
            title: e.title,
            kind: e.kind,
            endOn: e.endOn,
            state: e.state,
            coverage: e.coverage,
          });
    return {
      assets: rows.map((row) => {
        const current = coverage.get(row.id)?.current ?? null;
        return {
          ...row,
          coverage: current
            ? {
                entitlementId: current.id,
                title: current.title,
                endOn: current.endOn,
                coverage: current.coverage,
                correctiveLeft: current.correctiveLeft,
              }
            : null,
        };
      }),
      entitlements: [...entitlements.values()],
    };
  }

  private async lastTexts(ids: string[]) {
    const out = new Map<string, string | null>();
    for (const id of ids) {
      const last = (await this.messages.findFirst({
        where: { conversationId: id },
        orderBy: [{ createdAt: 'desc' }],
        select: { text: true },
      })) as { text: string | null } | null;
      out.set(id, last?.text?.slice(0, 140) ?? null);
    }
    return out;
  }

  private view(r: ConversationRow) {
    return {
      id: r.id,
      channel: r.channel,
      senderRef: r.senderRef,
      senderName: r.senderName,
      identification: r.identification,
      verifyMethod: r.verifyMethod,
      status: r.status,
      outcome: r.outcome,
      messages: r.messages,
      openedAt: r.openedAt,
      lastMessageAt: r.lastMessageAt,
      closedAt: r.closedAt,
      textPurged: !!r.textPurgedAt,
    };
  }

  private message(m: MessageRow) {
    return {
      id: m.id,
      direction: m.direction,
      author: m.author,
      text: m.text,
      attachments: Array.isArray(m.attachments) ? m.attachments : [],
      kbQueryId: m.kbQueryId,
      at: m.createdAt,
    };
  }

  private async mine(companyId: string, id: string) {
    const row = (await this.conversations.findFirst({
      where: { id, companyId },
    })) as ConversationRow | null;
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบบทสนทนา');
    return row;
  }

  private manage(actor: Principal) {
    if (!hasPermission(actor, MANAGE))
      throw new AppError('FORBIDDEN', 'ดูบทสนทนาได้เฉพาะทีมบริการ');
  }
}
