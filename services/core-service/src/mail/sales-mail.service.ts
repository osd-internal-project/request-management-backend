import { Injectable, Logger } from '@nestjs/common';
import {
  AppError,
  AuditWriter,
  auditActor,
  salesAccessSubject,
  visibleLeadsWhere,
  visibleSalesWhere,
  type Principal,
} from '@request-management/share';
import { DomainEventsService } from '../events/domain-events.service';
import { DOMAIN_EVENTS } from '../events/event-catalog';
import { LlmService } from '../llm/llm.service';
import { NotificationsService } from '../notifications/notifications.service';
import { QuotationPrintService } from '../crm/quotation-print.service';
import { QuotationsService } from '../crm/quotations.service';
import { ProductBundlesService } from '../crm/product-bundles.service';
import { LeadFilesService } from '../crm/lead-files.service';
import { requirementsOfLead } from '../crm/product-bundle-rules';
import { quotationPdf } from '../crm/quotation-pdf';
import {
  LeadActivityRepository,
  LeadRepository,
  OpportunityActivityRepository,
  OpportunityRepository,
} from '../crm/sales.repositories';
import { CrmEmailRepository } from './crm-email.repository';
import {
  type InboundMail,
  type MailAttachment,
  type MailClient,
  type MailMode,
  type SentMail,
} from './mail-client';
import { MailClientsService } from './mail-clients.service';
import {
  EMAIL_INTENT_LABELS,
  EMAIL_NEXT_STEPS,
  MAX_BODY_CHARS,
  intentByRules,
  intentPrompt,
  looksLikeEmail,
  normalizeAddress,
  parseIntent,
  replySubject,
  safeFileName,
  textToHtml,
  type EmailIntent,
  type IntentInput,
  type IntentResult,
} from './mail-rules';
import {
  decide,
  extractByRules,
  mergeRequirements,
  parseRequirementAnswer,
  productIn,
  requirementEmailBody,
  requirementPrompt,
  type Extracted,
  type MissingRequirement,
  type RequirementOutcome,
} from './requirement-rules';

/** What a caller writes — plain text; the service makes the HTML. */
export interface SalesMailInput {
  subject?: string;
  body: string;
  signature?: string;
  attachments?: MailAttachment[];
  /** attach the newest proposal on the Lead; none = refused, nothing sent */
  attachProposal?: boolean;
}

export interface CrmEmailRow {
  id: string;
  companyId: string;
  leadId: string | null;
  opportunityId: string | null;
  quotationId: string | null;
  direction: string;
  purpose: string;
  status: string;
  mailbox: string;
  fromAddress: string;
  toAddresses: string[];
  ccAddresses: string[];
  subject: string;
  bodyText: string;
  attachments: unknown;
  graphMessageId: string | null;
  internetMessageId: string | null;
  conversationId: string | null;
  replyToEmailId: string | null;
  intent: string | null;
  intentReason: string | null;
  intentSource: string | null;
  error: string | null;
  sentBy: string | null;
  occurredAt: Date;
  createdAt: Date;
}

interface LeadForMail {
  id: string;
  companyId: string;
  name: string;
  email: string | null;
  ownerUserId: string | null;
  convertedOpportunityId: string | null;
}

/** Most attachments a caller may send, and their total (Graph caps a request near 4 MB). */
const MAX_ATTACHMENTS = 5;
/** Large files go up in chunks (GraphMailClient.attach); Exchange caps a message near 35 MB. */
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/**
 * งานขายอัตโนมัติ (5 พ.ย. 2569) — the sales emails of a Lead and its deal:
 *
 * - `sendLeadIntro`: the thank-you (and proposal) to the Lead's address;
 * - `sendQuotation`: the approved quotation as a PDF, answering the
 *   customer's last message so it stays in one thread, then marked `sent`;
 * - `assessReply` / `sendRequirementRequest` (13 พ.ย. 2569): before quoting,
 *   what the customer wrote is checked against the product's questions —
 *   what is missing is asked for by email, in the same thread;
 * - `ingest`: a message in a thread the system opened — classified
 *   (`EMAIL_INTENTS`), logged as an activity, its owner notified, and
 *   `crm.email.received` emitted for the workflow to act on.
 *
 * Who is written to is never the caller's choice: the Lead's or the deal's
 * own address. Every send — failed ones too — is a row in `crm_emails`.
 */
@Injectable()
export class SalesMailService {
  private readonly logger = new Logger(SalesMailService.name);

  constructor(
    private readonly clients: MailClientsService,
    private readonly emails: CrmEmailRepository,
    private readonly leads: LeadRepository,
    private readonly opportunities: OpportunityRepository,
    private readonly leadActivities: LeadActivityRepository,
    private readonly opportunityActivities: OpportunityActivityRepository,
    private readonly quotations: QuotationsService,
    private readonly bundles: ProductBundlesService,
    private readonly leadFiles: LeadFilesService,
    private readonly print: QuotationPrintService,
    private readonly llm: LlmService,
    private readonly notifications: NotificationsService,
    private readonly events: DomainEventsService,
    private readonly audit: AuditWriter,
  ) {}

  async modeOf(companyId: string): Promise<MailMode> {
    return (await this.clients.forCompany(companyId)).mode;
  }

  // --- sending -------------------------------------------------------------

  async sendLeadIntro(leadId: string, input: SalesMailInput, actor: Principal) {
    const lead = await this.requireLead(leadId, actor);
    const mail = await this.requireMailbox(lead.companyId);
    if (!looksLikeEmail(lead.email)) {
      throw new AppError(
        'CRM_EMAIL_UNAVAILABLE',
        'Lead นี้ไม่มีอีเมลผู้ติดต่อ — เพิ่มอีเมลก่อนส่ง',
        [{ field: 'email', reason: 'missing' }],
      );
    }
    const attachments = [...(input.attachments ?? [])];
    if (input.attachProposal) {
      const proposal = await this.leadFiles.latestProposal(lead.id);
      if (!proposal) {
        throw new AppError(
          'CRM_EMAIL_UNAVAILABLE',
          'Lead นี้ยังไม่มีไฟล์ proposal — วางไฟล์ (ประเภท proposal) บน Lead ก่อนส่ง',
          [{ field: 'proposal', reason: 'missing' }],
        );
      }
      attachments.push({
        name: safeFileName(proposal.fileName),
        contentType: proposal.mimeType,
        contentBase64: proposal.content.toString('base64'),
      });
    }
    assertAttachments(attachments);
    const subject =
      input.subject?.trim() || `ขอบคุณที่สนใจบริการของเรา — ${lead.name}`;

    const row = await this.deliver(mail, actor, {
      companyId: lead.companyId,
      leadId: lead.id,
      opportunityId: lead.convertedOpportunityId,
      quotationId: null,
      purpose: 'lead_intro',
      to: [lead.email!.trim()],
      subject,
      body: input.body,
      signature: input.signature,
      attachments,
      replyTo: null,
    });
    await this.logActivity(row, actor);
    return this.view(row);
  }

  async sendQuotation(
    quotationId: string,
    input: Partial<SalesMailInput>,
    actor: Principal,
  ) {
    const quotation = (await this.quotations.findOne(
      quotationId,
      actor,
    )) as unknown as {
      id: string;
      quotationNo: string;
      version: number;
      status: string;
      opportunityId: string;
      title: string;
      companyId: string;
    };
    if (quotation.status !== 'approved') {
      throw new AppError(
        'CRM_QUOTATION_STATE_INVALID',
        'ส่งลูกค้าได้เฉพาะใบเสนอราคาที่อนุมัติแล้ว',
        [{ field: 'status', reason: quotation.status }],
      );
    }
    const opportunity = (await this.opportunities.findFirst({
      where: {
        id: quotation.opportunityId,
        AND: [visibleSalesWhere(salesAccessSubject(actor))],
      },
      select: { id: true, companyId: true, prospectEmail: true },
    })) as {
      id: string;
      companyId: string;
      prospectEmail: string | null;
    } | null;
    if (!opportunity) throw new AppError('NOT_FOUND', 'ไม่พบโอกาสการขาย');
    const mail = await this.requireMailbox(opportunity.companyId);
    const lead = (await this.leads.findFirst({
      where: { convertedOpportunityId: opportunity.id },
      select: { id: true, email: true },
    })) as { id: string; email: string | null } | null;

    const to = [opportunity.prospectEmail, lead?.email].find(looksLikeEmail);
    if (!to) {
      throw new AppError(
        'CRM_EMAIL_UNAVAILABLE',
        'ดีลนี้ไม่มีอีเมลผู้ติดต่อ — เพิ่มอีเมลของผู้มุ่งหวังก่อนส่ง',
        [{ field: 'prospect_email', reason: 'missing' }],
      );
    }

    // answer the customer's last message, else our own last one: one thread
    const thread = (await this.emails.findFirst({
      where: {
        companyId: opportunity.companyId,
        graphMessageId: { not: null },
        status: { in: ['sent', 'received'] },
        OR: [
          { opportunityId: opportunity.id },
          ...(lead ? [{ leadId: lead.id }] : []),
        ],
      },
      orderBy: [{ direction: 'asc' }, { occurredAt: 'desc' }],
      select: {
        id: true,
        graphMessageId: true,
        subject: true,
        direction: true,
      },
    })) as {
      id: string;
      graphMessageId: string;
      subject: string;
      direction: string;
    } | null;

    const label = `${quotation.quotationNo}${quotation.version > 1 ? ` v${quotation.version}` : ''}`;
    const pdf = await quotationPdf(
      await this.print.printView(quotation.id, actor),
    );
    const subject =
      input.subject?.trim() ||
      (thread
        ? replySubject(thread.subject)
        : `ใบเสนอราคา ${label} — ${quotation.title}`);
    const body =
      input.body?.trim() ||
      [
        'เรียน ลูกค้า',
        `บริษัทขอส่งใบเสนอราคาเลขที่ ${label} สำหรับ ${quotation.title} ตามไฟล์แนบ`,
        'หากต้องการยืนยันการสั่งซื้อ สามารถตอบกลับอีเมลนี้ หรือแนบใบสั่งซื้อ (PO) มาได้เลย',
        'ขอบคุณครับ/ค่ะ',
      ].join('\n\n');

    const row = await this.deliver(mail, actor, {
      companyId: opportunity.companyId,
      leadId: lead?.id ?? null,
      opportunityId: opportunity.id,
      quotationId: quotation.id,
      purpose: 'quotation',
      to: [to.trim()],
      subject,
      body,
      signature: input.signature,
      attachments: [
        {
          name: safeFileName(`ใบเสนอราคา-${label}.pdf`),
          contentType: 'application/pdf',
          contentBase64: pdf.toString('base64'),
        },
      ],
      replyTo: thread
        ? { id: thread.id, graphMessageId: thread.graphMessageId }
        : null,
    });
    await this.logActivity(row, actor);
    // the mail went: now the version is locked as sent
    const sent = await this.quotations.send(quotation.id, actor);
    // the deal now has a price on the table (6 พ.ย. 2569, user decision)
    await this.advanceDeal(opportunity.id, ['qualifying'], 'proposing', {
      amount: (sent as unknown as { netTotal?: unknown }).netTotal ?? null,
      reason: `ส่งใบเสนอราคา ${label} ทางอีเมล`,
      actor,
    });
    return { email: this.view(row), quotation: sent };
  }

  /**
   * The quotation the workflow asks for. Items given = those; none = what the
   * Lead behind the deal asks for (`ProductBundlesService.itemsForLead`): its
   * own list `intake_data.products`, else the mandatory items of the bundle
   * of its product (12 พ.ย. 2569), else its `subProduct` × 1.
   */
  async standardQuotation(
    opportunityId: string,
    input: {
      items?: {
        product_code: string;
        quantity: number;
        term_months?: number;
      }[];
      title?: string;
      note?: string;
    },
    actor: Principal,
  ) {
    let items = input.items ?? [];
    if (!items.length) {
      const lead = (await this.leads.findFirst({
        where: {
          convertedOpportunityId: opportunityId,
          companyId: actor.activeCompanyId,
        },
        select: { subProduct: true, intakeData: true },
      })) as { subProduct: string | null; intakeData: unknown } | null;
      items = (await this.bundles.itemsForLead(actor.activeCompanyId, lead))
        .items;
    }
    if (!items.length) {
      throw new AppError(
        'CRM_QUOTATION_UNPRICED',
        'ไม่รู้ว่าลูกค้าสนใจสินค้าใด — ไม่มีรายการสินค้าบน Lead ให้พนักงานขายทำใบเสนอราคาเอง',
        [{ field: 'items', reason: 'no_products' }],
      );
    }
    return this.quotations.createAtStandardPrice(opportunityId, items, actor, {
      title: input.title,
      note: input.note,
    });
  }

  // --- requirements before a quotation (13 พ.ย. 2569) -----------------------

  /**
   * Is what the customer wrote enough to quote from? Reads the reply for the
   * product, the quantity and the answers to the product's questions, keeps
   * them on the Lead (`intake_data.requirements`, added to what earlier
   * replies said), and answers what the workflow does next
   * (`REQUIREMENT_OUTCOMES`). Asked again later — the salesperson added a
   * price, the customer answered — it judges afresh.
   */
  async assessReply(emailId: string, actor: Principal) {
    const email = await this.requireVisibleEmail(emailId, actor);
    if (email.direction !== 'in' || !email.leadId) {
      throw new AppError(
        'VALIDATION_FAILED',
        'ประเมิน requirement ได้เฉพาะอีเมลที่ลูกค้าตอบเข้ามาในเธรดของ Lead',
        [{ field: 'email_id', reason: 'not_a_lead_reply' }],
      );
    }
    const lead = (await this.leads.findFirst({
      where: { id: email.leadId, companyId: email.companyId },
      select: {
        id: true,
        name: true,
        ownerUserId: true,
        subProduct: true,
        intakeData: true,
        convertedOpportunityId: true,
      },
    })) as {
      id: string;
      name: string;
      ownerUserId: string | null;
      subProduct: string | null;
      intakeData: unknown;
      convertedOpportunityId: string | null;
    } | null;
    if (!lead) throw new AppError('NOT_FOUND', 'ไม่พบ Lead ที่ระบุ');

    const companyId = email.companyId;
    const names = await this.bundles.namesOf(companyId);
    const known = requirementsOfLead(lead);
    const withTold = (told: typeof known) => ({
      subProduct: lead.subProduct,
      intakeData: {
        ...(lead.intakeData && typeof lead.intakeData === 'object'
          ? (lead.intakeData as Record<string, unknown>)
          : {}),
        requirements: told,
      },
    });
    const asksSent = await this.emails.count({
      where: {
        companyId,
        leadId: lead.id,
        purpose: 'requirement_request',
        status: 'sent',
      },
    });

    // the product's questions are needed to read the answers: find the
    // product first, by name alone
    const named = productIn(email.bodyText, names);
    const first = await this.bundles.itemsForLead(
      companyId,
      withTold({ ...known, product: named ?? known.product }),
    );
    const found = await this.extractRequirements(companyId, {
      text: email.bodyText,
      productNames: names,
      questions: first.requirements ?? [],
      answeringAsk: asksSent > 0,
    });
    let told = mergeRequirements(known, found);
    let quoted = await this.bundles.itemsForLead(companyId, withTold(told));
    // the reader named a product the keyword pass missed ("IP Phone" for
    // IP-PHONE): its questions were never put to the reply — read once more
    const asked = new Set((first.requirements ?? []).map((q) => q.key));
    const unread = (quoted.requirements ?? []).filter((q) => !asked.has(q.key));
    if (unread.length) {
      const again = await this.extractRequirements(companyId, {
        text: email.bodyText,
        productNames: names,
        questions: unread,
        answeringAsk: asksSent > 0,
      });
      told = mergeRequirements(told, { ...again, product: null });
      quoted = await this.bundles.itemsForLead(companyId, withTold(told));
    }
    const codes = [
      ...new Set(quoted.items.map((item) => item.product_code.trim())),
    ];
    const { products, priceOf } = codes.length
      ? await this.quotations.standardPricesFor(companyId, codes, 'THB')
      : { products: new Map(), priceOf: new Map() };
    const decision = decide({
      product: quoted.product,
      productNames: names,
      hasItems: quoted.items.length > 0,
      unpriced: codes.filter(
        (code) => !products.has(code) || !priceOf.has(code),
      ),
      quantityKnown: quoted.source === 'lead' || told.quantity !== null,
      questions: quoted.requirements ?? [],
      answers: told.answers,
      asksSent,
    });

    await this.leads.mergeIntakeData(
      lead.id,
      {
        requirements: {
          ...told,
          outcome: decision.outcome,
          missing: decision.missing,
          reason: decision.reason,
          email_id: email.id,
          assessed_at: new Date().toISOString(),
        },
      },
      [],
      actor.userId,
    );
    await this.audit.record({
      eventType: 'crm.lead.requirements_assessed',
      companyId,
      ...auditActor(actor),
      resourceType: 'lead',
      resourceId: lead.id,
      // which questions, never what the customer answered
      after: {
        emailId: email.id,
        outcome: decision.outcome,
        product: quoted.product,
        missing: decision.missing.map((item) => item.key),
        source: found.source,
      },
    });
    if (decision.outcome === 'no_solution' || decision.outcome === 'handover') {
      // the salesperson's turn: say why and what to do
      await this.notifyOwner(email, {
        label:
          decision.outcome === 'no_solution'
            ? 'ไม่มีราคา/Solution ในระบบ'
            : 'ข้อมูลยังไม่ครบ',
        nextStep:
          decision.outcome === 'no_solution'
            ? `${decision.reason} — ขอราคาจาก Pricing หรือขอ Solution จาก Pre-Sales แล้วกด "เริ่ม" ขั้นใบเสนอราคา`
            : `${decision.reason} — ติดต่อลูกค้าเองแล้วทำใบเสนอราคา`,
      });
    }
    return {
      email_id: email.id,
      lead_id: lead.id,
      opportunity_id: lead.convertedOpportunityId,
      outcome: decision.outcome,
      reason: decision.reason,
      product: quoted.product,
      quantity: told.quantity,
      answers: told.answers,
      missing: decision.missing,
      missing_count: decision.missing.length,
      asks_sent: asksSent,
      source: found.source,
    };
  }

  /**
   * Asks the customer for what `assessReply` found missing, answering their
   * own message so the thread stays one. Their answer comes back as a new
   * `crm.email.received` (interested) and is assessed again.
   */
  async sendRequirementRequest(
    emailId: string,
    input: { intro?: string; signature?: string },
    actor: Principal,
  ) {
    const email = await this.requireVisibleEmail(emailId, actor);
    if (email.direction !== 'in' || !email.leadId) {
      throw new AppError(
        'VALIDATION_FAILED',
        'ถาม requirement ได้เฉพาะในเธรดที่ลูกค้าตอบเข้ามาของ Lead',
        [{ field: 'email_id', reason: 'not_a_lead_reply' }],
      );
    }
    const lead = (await this.leads.findFirst({
      where: { id: email.leadId, companyId: email.companyId },
      select: {
        id: true,
        email: true,
        intakeData: true,
        convertedOpportunityId: true,
      },
    })) as {
      id: string;
      email: string | null;
      intakeData: unknown;
      convertedOpportunityId: string | null;
    } | null;
    if (!lead) throw new AppError('NOT_FOUND', 'ไม่พบ Lead ที่ระบุ');
    const stored = assessmentOf(lead.intakeData);
    if (stored.outcome !== 'ask' || !stored.missing.length) {
      throw new AppError(
        'CONFLICT',
        'ไม่มีข้อที่ต้องถามลูกค้า — ประเมินคำตอบของลูกค้าก่อน (assessment)',
        [{ field: 'requirements', reason: stored.outcome ?? 'not_assessed' }],
      );
    }
    const mail = await this.requireMailbox(email.companyId);
    // they wrote from this address: answer it, else the Lead's own
    const to = [email.fromAddress, lead.email].find(looksLikeEmail);
    if (!to) {
      throw new AppError(
        'CRM_EMAIL_UNAVAILABLE',
        'Lead นี้ไม่มีอีเมลผู้ติดต่อ — เพิ่มอีเมลก่อนส่ง',
        [{ field: 'email', reason: 'missing' }],
      );
    }
    const row = await this.deliver(mail, actor, {
      companyId: email.companyId,
      leadId: lead.id,
      opportunityId: lead.convertedOpportunityId,
      quotationId: null,
      purpose: 'requirement_request',
      to: [to.trim()],
      subject: replySubject(email.subject),
      body: requirementEmailBody(
        stored.missing,
        requirementsOfLead({ subProduct: null, intakeData: lead.intakeData })
          .product,
        input.intro,
      ),
      signature: input.signature,
      attachments: [],
      replyTo: email.graphMessageId
        ? { id: email.id, graphMessageId: email.graphMessageId }
        : null,
    });
    await this.logActivity(row, actor);
    return { ...this.view(row), asked: stored.missing };
  }

  private async extractRequirements(
    companyId: string,
    input: Parameters<typeof extractByRules>[0],
  ): Promise<Extracted & { source: 'llm' | 'rules' }> {
    if (this.llm.mode !== 'mock') {
      try {
        const prompt = requirementPrompt(input);
        const answer = await this.llm.chat(
          { companyId, task: 'crm.email.requirements', userId: null },
          [
            { role: 'system', content: prompt.system },
            { role: 'user', content: prompt.user },
          ],
          { maxTokens: 600, temperature: 0 },
        );
        const parsed = parseRequirementAnswer(answer.text, input.questions);
        if (parsed) return { ...parsed, source: 'llm' };
      } catch (failure) {
        this.logger.warn(
          `requirements by LLM failed, using rules: ${failure instanceof Error ? failure.message : String(failure)}`,
        );
      }
    }
    return { ...extractByRules(input), source: 'rules' };
  }

  // --- receiving -----------------------------------------------------------

  /** Known thread ids among these — the poller reads only those messages. */
  async knownThreads(conversationIds: readonly string[]): Promise<Set<string>> {
    if (!conversationIds.length) return new Set();
    const rows = (await this.emails.findMany({
      where: { conversationId: { in: [...new Set(conversationIds)] } },
      select: { conversationId: true },
      distinct: ['conversationId'],
    })) as { conversationId: string }[];
    return new Set(rows.map((row) => row.conversationId));
  }

  async alreadyStored(internetMessageId: string | null): Promise<boolean> {
    if (!internetMessageId) return false;
    return (await this.emails.count({ where: { internetMessageId } })) > 0;
  }

  /**
   * A customer's message. Null when it is not in a thread the system opened,
   * is one of our own (sent from this mailbox), or was stored already.
   */
  async ingest(
    message: InboundMail,
    mailbox: string,
  ): Promise<CrmEmailRow | null> {
    if (!message.conversationId) return null;
    if (normalizeAddress(message.from) === normalizeAddress(mailbox)) {
      return null;
    }
    // a thread this mailbox opened — another company's mailbox is not ours to read
    const origin = (await this.emails.findFirst({
      where: {
        conversationId: message.conversationId,
        mailbox: { equals: mailbox, mode: 'insensitive' },
      },
      orderBy: { occurredAt: 'desc' },
    })) as CrmEmailRow | null;
    if (!origin) return null;
    if (
      message.internetMessageId &&
      (await this.emails.count({
        where: {
          companyId: origin.companyId,
          internetMessageId: message.internetMessageId,
        },
      }))
    ) {
      return null;
    }

    const thread = (await this.emails.findMany({
      where: {
        companyId: origin.companyId,
        conversationId: message.conversationId,
      },
      select: {
        quotationId: true,
        purpose: true,
        status: true,
        direction: true,
        occurredAt: true,
      },
      orderBy: { occurredAt: 'asc' },
    })) as {
      quotationId: string | null;
      purpose: string;
      status: string;
      direction: string;
      occurredAt: Date;
    }[];
    const quoted = thread.find(
      (row) => row.purpose === 'quotation' && row.status === 'sent',
    );
    const text = message.text.slice(0, MAX_BODY_CHARS);
    // the Lead may have become a deal since the thread began (stage 1 converts)
    const opportunityId =
      origin.opportunityId ??
      (origin.leadId
        ? ((
            (await this.leads.findFirst({
              where: { id: origin.leadId },
              select: { convertedOpportunityId: true },
            })) as { convertedOpportunityId: string | null } | null
          )?.convertedOpportunityId ?? null)
        : null);
    let classified = await this.classify(origin.companyId, {
      subject: message.subject,
      text,
      attachmentNames: message.attachments.map((file) => file.name),
      quotationSent: !!quoted,
    });
    // "50 เครื่อง ติดตั้งที่ระยอง" says nothing by itself — but answering our
    // requirement email it is the customer going on (13 พ.ย. 2569)
    const lastOut = thread
      .filter((row) => row.direction === 'out' && row.status === 'sent')
      .pop();
    if (
      classified.intent === 'unclear' &&
      lastOut?.purpose === 'requirement_request' &&
      text.trim()
    ) {
      classified = {
        ...classified,
        intent: 'interested',
        reason: 'ตอบคำถาม requirement ที่ระบบถามไป',
      };
    }

    const row = (await this.emails.create({
      data: {
        companyId: origin.companyId,
        leadId: origin.leadId,
        opportunityId,
        quotationId: quoted?.quotationId ?? origin.quotationId,
        direction: 'in',
        purpose: 'reply',
        status: 'received',
        mailbox,
        fromAddress: message.from,
        toAddresses: [...message.to],
        ccAddresses: [...message.cc],
        subject: message.subject.slice(0, 500),
        bodyText: text,
        attachments: message.attachments.map((file) => ({ ...file })),
        graphMessageId: message.graphMessageId,
        internetMessageId: message.internetMessageId,
        conversationId: message.conversationId,
        replyToEmailId: origin.id,
        intent: classified.intent,
        intentReason: classified.reason,
        intentSource: classified.source,
        occurredAt: message.receivedAt,
      },
    })) as CrmEmailRow;

    await this.audit.record({
      eventType: 'crm.email.received',
      companyId: row.companyId,
      actorId: null,
      resourceType: 'crm_email',
      resourceId: row.id,
      after: {
        leadId: row.leadId,
        opportunityId: row.opportunityId,
        intent: row.intent,
        intentSource: row.intentSource,
        attachments: message.attachments.length,
      },
    });
    await this.logActivity(row, null);
    if (row.intent === 'negotiation' && row.opportunityId) {
      await this.advanceDeal(
        row.opportunityId,
        ['qualifying', 'proposing'],
        'negotiating',
        { amount: null, reason: 'ลูกค้าขอต่อรองทางอีเมล', actor: null },
      );
    }
    await this.notifyOwner(row);
    await this.events.emit({
      name: DOMAIN_EVENTS.crmEmailReceived,
      payload: {
        company_id: row.companyId,
        email_id: row.id,
        lead_id: row.leadId,
        opportunity_id: row.opportunityId,
        quotation_id: row.quotationId,
        intent: row.intent ?? 'unclear',
      },
    });
    return row;
  }

  /**
   * MAIL_MODE=mock only — the customer "answers" one of the system's emails,
   * so the whole flow can be walked before IT opens the real mailbox.
   */
  async simulateReply(
    emailId: string,
    input: { text: string; attachmentNames?: string[]; from?: string },
    actor: Principal,
  ) {
    const origin = await this.requireVisibleEmail(emailId, actor);
    const mode = await this.modeOf(origin.companyId);
    if (mode !== 'mock') {
      throw new AppError(
        'CRM_EMAIL_UNAVAILABLE',
        'จำลองคำตอบได้เฉพาะเมื่อตั้งระบบอีเมลเป็นโหมดจำลอง (mock)',
        [{ field: 'mail_mode', reason: mode }],
      );
    }
    if (origin.direction !== 'out' || !origin.conversationId) {
      throw new AppError(
        'VALIDATION_FAILED',
        'จำลองคำตอบได้เฉพาะอีเมลที่ระบบส่ง',
        [{ field: 'email_id', reason: 'not_outbound' }],
      );
    }
    const row = await this.ingest(
      {
        graphMessageId: `mock-in-${Date.now()}`,
        internetMessageId: `<sim-${Date.now()}-${Math.random().toString(36).slice(2)}@mock.mail>`,
        conversationId: origin.conversationId,
        receivedAt: new Date(),
        from:
          input.from?.trim() || origin.toAddresses[0] || 'customer@example.com',
        to: [origin.mailbox],
        cc: [],
        subject: replySubject(origin.subject),
        text: input.text,
        attachments: (input.attachmentNames ?? []).map((name) => ({
          name,
          contentType: name.toLowerCase().endsWith('.pdf')
            ? 'application/pdf'
            : 'application/octet-stream',
          size: 0,
        })),
      },
      origin.mailbox,
    );
    if (!row) throw new AppError('CONFLICT', 'บันทึกคำตอบจำลองไม่ได้');
    return this.view(row);
  }

  // --- reading -------------------------------------------------------------

  async listForLead(leadId: string, actor: Principal) {
    const lead = await this.requireLead(leadId, actor);
    const rows = (await this.emails.findMany({
      where: {
        companyId: lead.companyId,
        OR: [
          { leadId: lead.id },
          ...(lead.convertedOpportunityId
            ? [{ opportunityId: lead.convertedOpportunityId }]
            : []),
        ],
      },
      orderBy: { occurredAt: 'asc' },
    })) as CrmEmailRow[];
    return {
      mode: await this.modeOf(actor.activeCompanyId),
      items: rows.map((row) => this.view(row)),
    };
  }

  async listForOpportunity(opportunityId: string, actor: Principal) {
    const opportunity = (await this.opportunities.findFirst({
      where: {
        id: opportunityId,
        AND: [visibleSalesWhere(salesAccessSubject(actor))],
      },
      select: { id: true, companyId: true },
    })) as { id: string; companyId: string } | null;
    if (!opportunity) throw new AppError('NOT_FOUND', 'ไม่พบโอกาสการขาย');
    const lead = (await this.leads.findFirst({
      where: { convertedOpportunityId: opportunity.id },
      select: { id: true },
    })) as { id: string } | null;
    const rows = (await this.emails.findMany({
      where: {
        companyId: opportunity.companyId,
        OR: [
          { opportunityId: opportunity.id },
          ...(lead ? [{ leadId: lead.id }] : []),
        ],
      },
      orderBy: { occurredAt: 'asc' },
    })) as CrmEmailRow[];
    return {
      mode: await this.modeOf(actor.activeCompanyId),
      items: rows.map((row) => this.view(row)),
    };
  }

  async findOne(id: string, actor: Principal) {
    return this.view(await this.requireVisibleEmail(id, actor));
  }

  // --- internals -----------------------------------------------------------

  private async requireMailbox(companyId: string): Promise<MailClient> {
    const resolved = await this.clients.forCompany(companyId);
    if (!resolved.client) {
      throw new AppError(
        'CRM_EMAIL_UNAVAILABLE',
        resolved.problem ??
          'ยังไม่ได้เปิดระบบอีเมล — ตั้งค่าได้ที่ ตั้งค่า → อีเมลงานขาย',
        [{ field: 'mail_mode', reason: resolved.mode }],
      );
    }
    return resolved.client;
  }

  private async requireLead(
    id: string,
    actor: Principal,
  ): Promise<LeadForMail> {
    const lead = (await this.leads.findFirst({
      where: { id, AND: [visibleLeadsWhere(salesAccessSubject(actor))] },
      select: {
        id: true,
        companyId: true,
        name: true,
        email: true,
        ownerUserId: true,
        convertedOpportunityId: true,
      },
    })) as LeadForMail | null;
    // SCOPE-03: unseen = 404
    if (!lead) throw new AppError('NOT_FOUND', 'ไม่พบ Lead ที่ระบุ');
    return lead;
  }

  /** An email is visible to whoever sees its Lead or its deal. */
  private async requireVisibleEmail(
    id: string,
    actor: Principal,
  ): Promise<CrmEmailRow> {
    const row = (await this.emails.findFirst({
      where: { id, companyId: actor.activeCompanyId },
    })) as CrmEmailRow | null;
    const subject = salesAccessSubject(actor);
    const visible =
      row &&
      ((row.leadId &&
        (await this.leads.count({
          where: { id: row.leadId, AND: [visibleLeadsWhere(subject)] },
        }))) ||
        (row.opportunityId &&
          (await this.opportunities.count({
            where: { id: row.opportunityId, AND: [visibleSalesWhere(subject)] },
          }))));
    if (!row || !visible) throw new AppError('NOT_FOUND', 'ไม่พบอีเมลที่ระบุ');
    return row;
  }

  private async deliver(
    mail: MailClient,
    actor: Principal,
    out: {
      companyId: string;
      leadId: string | null;
      opportunityId: string | null;
      quotationId: string | null;
      purpose: 'lead_intro' | 'quotation' | 'requirement_request';
      to: string[];
      subject: string;
      body: string;
      signature?: string;
      attachments: MailAttachment[];
      replyTo: { id: string; graphMessageId: string } | null;
    },
  ): Promise<CrmEmailRow> {
    let sent: SentMail | null = null;
    let error: string | null = null;
    try {
      sent = await mail.send({
        to: out.to,
        subject: out.subject,
        html: textToHtml(out.body, out.signature),
        attachments: out.attachments,
        replyToGraphId: out.replyTo?.graphMessageId ?? null,
      });
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
      this.logger.warn(`send ${out.purpose} failed: ${error}`);
    }

    const row = (await this.emails.create({
      data: {
        companyId: out.companyId,
        leadId: out.leadId,
        opportunityId: out.opportunityId,
        quotationId: out.quotationId,
        direction: 'out',
        purpose: out.purpose,
        status: sent ? 'sent' : 'failed',
        mailbox: mail.mailbox,
        fromAddress: mail.mailbox,
        toAddresses: out.to,
        subject: out.subject.slice(0, 500),
        bodyText: out.body.slice(0, MAX_BODY_CHARS),
        attachments: out.attachments.map((file) => ({
          name: file.name,
          contentType: file.contentType,
          size: Math.floor((file.contentBase64.length * 3) / 4),
        })),
        graphMessageId: sent?.graphMessageId ?? null,
        internetMessageId: sent?.internetMessageId ?? null,
        conversationId: sent?.conversationId ?? null,
        replyToEmailId: out.replyTo?.id ?? null,
        error: error?.slice(0, 1000) ?? null,
        sentBy: actor.userId,
      },
    })) as CrmEmailRow;

    await this.audit.record({
      eventType: sent ? 'crm.email.sent' : 'crm.email.failed',
      companyId: out.companyId,
      ...auditActor(actor),
      resourceType: 'crm_email',
      resourceId: row.id,
      after: {
        purpose: out.purpose,
        leadId: out.leadId,
        opportunityId: out.opportunityId,
        quotationId: out.quotationId,
        attachments: out.attachments.length,
        ...(error ? { error: row.error } : {}),
      },
    });

    if (!sent) {
      throw new AppError(
        'CRM_EMAIL_SEND_FAILED',
        'ส่งอีเมลไม่สำเร็จ — ดูรายละเอียดในประวัติอีเมล',
        [{ field: 'email_id', reason: row.id }],
      );
    }
    return row;
  }

  private async classify(
    companyId: string,
    input: IntentInput,
  ): Promise<IntentResult & { source: 'llm' | 'rules' }> {
    if (this.llm.mode !== 'mock') {
      try {
        const prompt = intentPrompt(input);
        const answer = await this.llm.chat(
          { companyId, task: 'crm.email.intent', userId: null },
          [
            { role: 'system', content: prompt.system },
            { role: 'user', content: prompt.user },
          ],
          { maxTokens: 200, temperature: 0 },
        );
        const parsed = parseIntent(answer.text, input.quotationSent);
        if (parsed) return { ...parsed, source: 'llm' };
      } catch (failure) {
        this.logger.warn(
          `classify by LLM failed, using rules: ${failure instanceof Error ? failure.message : String(failure)}`,
        );
      }
    }
    return { ...intentByRules(input), source: 'rules' };
  }

  private async logActivity(row: CrmEmailRow, actor: Principal | null) {
    const inbound = row.direction === 'in';
    const subject = (
      inbound
        ? `อีเมลจากลูกค้า (${EMAIL_INTENT_LABELS[(row.intent ?? 'unclear') as EmailIntent]}): ${row.subject}`
        : `ส่งอีเมล: ${row.subject}`
    ).slice(0, 255);
    const detail = row.bodyText.slice(0, 4000) || null;
    const by = actor?.userId ?? 'system';
    const now = new Date();
    try {
      // after conversion the deal is where the salesperson looks
      if (row.opportunityId) {
        await this.opportunityActivities.create({
          data: {
            companyId: row.companyId,
            opportunityId: row.opportunityId,
            type: 'email',
            subject,
            detail,
            completedAt: now,
            completedBy: by,
            createdBy: by,
          },
        });
      } else if (row.leadId) {
        await this.leadActivities.create({
          data: {
            companyId: row.companyId,
            leadId: row.leadId,
            type: 'email',
            subject,
            detail,
            completedAt: now,
            completedBy: by,
            createdBy: by,
          },
        });
      }
    } catch (failure) {
      // the email itself is recorded; a missing activity line is not worth failing it
      this.logger.warn(
        `activity for email ${row.id} not written: ${failure instanceof Error ? failure.message : String(failure)}`,
      );
    }
  }

  /**
   * Moves an open deal forward when the email flow says so — only from the
   * stages named, never backwards, never to won/lost (won = a sale order,
   * PO 10 ก.ย. 2569). A deal amount someone already set is kept.
   */
  private async advanceDeal(
    opportunityId: string,
    from: readonly string[],
    to: 'proposing' | 'negotiating',
    change: { amount: unknown; reason: string; actor: Principal | null },
  ) {
    const deal = (await this.opportunities.findFirst({
      where: { id: opportunityId },
      select: { id: true, companyId: true, stage: true, amount: true },
    })) as {
      id: string;
      companyId: string;
      stage: string;
      amount: unknown;
    } | null;
    if (!deal || !from.includes(deal.stage)) return;
    const amount =
      deal.amount === null && change.amount !== null
        ? change.amount
        : undefined;
    await this.opportunities.update({
      where: { id: deal.id },
      data: {
        stage: to,
        ...(amount !== undefined ? { amount: amount as never } : {}),
        updatedBy: change.actor?.userId ?? null,
      },
    });
    await this.audit.record({
      eventType: 'crm.opportunity.stage_changed',
      companyId: deal.companyId,
      ...(change.actor ? auditActor(change.actor) : { actorId: null }),
      resourceType: 'opportunity',
      resourceId: deal.id,
      before: { stage: deal.stage },
      after: {
        stage: to,
        ...(amount !== undefined ? { amount: amount as never } : {}),
        reason: change.reason,
      },
    });
  }

  private async notifyOwner(
    row: CrmEmailRow,
    say?: { label: string; nextStep: string },
  ) {
    const target = row.opportunityId
      ? ((await this.opportunities.findFirst({
          where: { id: row.opportunityId },
          select: { ownerUserId: true, title: true },
        })) as { ownerUserId: string | null; title: string } | null)
      : row.leadId
        ? ((await this.leads.findFirst({
            where: { id: row.leadId },
            select: { ownerUserId: true, name: true },
          })) as { ownerUserId: string | null; name: string } | null)
        : null;
    if (!target?.ownerUserId) return;
    await this.notifications.salesEmailReceived(
      target.ownerUserId,
      row.companyId,
      {
        id: row.id,
        intentLabel:
          say?.label ??
          EMAIL_INTENT_LABELS[(row.intent ?? 'unclear') as EmailIntent],
        nextStep:
          say?.nextStep ??
          EMAIL_NEXT_STEPS[(row.intent ?? 'unclear') as EmailIntent],
        party: 'title' in target ? target.title : target.name,
        subject: row.subject,
        sender: row.fromAddress,
        resourceType: row.opportunityId ? 'opportunity' : 'lead',
        resourceId: (row.opportunityId ?? row.leadId)!,
      },
    );
  }

  /** What leaves the service — snake_case, as every API here answers. */
  view(row: CrmEmailRow) {
    return {
      id: row.id,
      lead_id: row.leadId,
      opportunity_id: row.opportunityId,
      quotation_id: row.quotationId,
      direction: row.direction,
      purpose: row.purpose,
      status: row.status,
      mailbox: row.mailbox,
      from: row.fromAddress,
      to: row.toAddresses,
      cc: row.ccAddresses,
      subject: row.subject,
      body_text: row.bodyText,
      attachments: row.attachments,
      conversation_id: row.conversationId,
      reply_to_email_id: row.replyToEmailId,
      intent: row.intent,
      intent_label: row.intent
        ? EMAIL_INTENT_LABELS[row.intent as EmailIntent]
        : null,
      intent_reason: row.intentReason,
      intent_source: row.intentSource,
      error: row.error,
      occurred_at: row.occurredAt.toISOString(),
    };
  }
}

/** What `assessReply` last wrote on the Lead. */
function assessmentOf(intakeData: unknown): {
  outcome: RequirementOutcome | null;
  missing: MissingRequirement[];
} {
  const intake =
    intakeData && typeof intakeData === 'object'
      ? (intakeData as Record<string, unknown>)
      : {};
  const raw = (
    intake.requirements && typeof intake.requirements === 'object'
      ? intake.requirements
      : {}
  ) as Record<string, unknown>;
  const missing = (Array.isArray(raw.missing) ? raw.missing : []).flatMap(
    (item): MissingRequirement[] => {
      const row = (item && typeof item === 'object' ? item : {}) as Record<
        string,
        unknown
      >;
      return typeof row.key === 'string' && typeof row.question === 'string'
        ? [{ key: row.key, question: row.question }]
        : [];
    },
  );
  return {
    outcome:
      typeof raw.outcome === 'string'
        ? (raw.outcome as RequirementOutcome)
        : null,
    missing,
  };
}

function assertAttachments(files: readonly MailAttachment[] | undefined) {
  if (!files?.length) return;
  if (files.length > MAX_ATTACHMENTS) {
    throw new AppError(
      'VALIDATION_FAILED',
      `แนบไฟล์ได้ไม่เกิน ${MAX_ATTACHMENTS} ไฟล์`,
      [{ field: 'attachments', reason: 'too_many' }],
    );
  }
  const bytes = files.reduce(
    (sum, file) => sum + Math.floor((file.contentBase64.length * 3) / 4),
    0,
  );
  if (bytes > MAX_ATTACHMENT_BYTES) {
    throw new AppError('VALIDATION_FAILED', 'ไฟล์แนบรวมกันต้องไม่เกิน 20 MB', [
      { field: 'attachments', reason: 'too_large' },
    ]);
  }
}
