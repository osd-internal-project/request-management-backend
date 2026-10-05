import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AppError,
  AuditWriter,
  auditActor,
  Principal,
  PrismaTransactionService,
} from '@request-management/share';
import { CompanyMemberRepository } from '../access/company-member.repository';
import { CustomerRepository } from '../crm/customer.repository';
import { CompanyRepository } from '../crm/product.repositories';
import { CrmConfigRepository } from '../crm/segment.repositories';
import { DomainEventsService } from '../events/domain-events.service';
import { DOMAIN_EVENTS } from '../events/event-catalog';
import { NotificationsService } from '../notifications/notifications.service';
import { RequestRepository } from '../requests/request.repository';
import { SurveySender } from './survey-sender';
import {
  answerProblems,
  expiryFrom,
  groupFigures,
  isLow,
  newToken,
  surveyFigures,
  surveyState,
  tokenHash,
  type SurveyAnswer,
} from './survey-rules';
import { ListSurveysQueryDto } from './support.dto';
import {
  ServiceSurveyRepository,
  ServiceWorkOrderRepository,
} from './support.repositories';

interface SurveyRow {
  id: string;
  companyId: string;
  workOrderId: string;
  requestId: string;
  customerId: string | null;
  assigneeUserId: string | null;
  tokenHash: string;
  expiresAt: Date;
  sentVia: string;
  sentTo: string | null;
  sentAt: Date | null;
  answeredAt: Date | null;
  overall: number | null;
  speed: number | null;
  technician: number | null;
  outcome: number | null;
  comment: string | null;
  createdAt: Date;
}

interface CaseRow {
  id: string;
  companyId: string;
  requestNo: string | null;
  status: string;
  assigneeUserId: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactLineUserId: string | null;
  formData: unknown;
  completedAt: Date | null;
}

const iso = (value: Date | null) => value?.toISOString() ?? null;
const subjectOf = (row: { formData: unknown } | null | undefined) => {
  const form = (row?.formData ?? {}) as { subject?: unknown };
  return typeof form.subject === 'string' ? form.subject : '';
};

/**
 * CD-248 ความพึงพอใจหลังปิดงานบริการ — when a service job's case is done
 * (`request.completed`), a private link goes to whoever raised it (LINE if
 * it came through LINE, else the contact email) — or the team copies it from
 * the job. The customer answers once (overall 1–5, three aspects, a comment)
 * on a public page; a low overall tells the account owner. The answers make
 * the service team's figures (per month, per technician) and feed the
 * customer's health in Keeper (CD-86).
 *
 * The public read/answer is the second public business surface of
 * core-service (AGENTS.md), on the e-sign pattern: the link's secret is the
 * credential and only its hash is stored.
 *
 * Who: `service.asset.read` reads; `service.asset.manage` reissues a link.
 */
@Injectable()
export class SurveysService implements OnModuleInit {
  private readonly logger = new Logger(SurveysService.name);

  constructor(
    private readonly surveys: ServiceSurveyRepository,
    private readonly orders: ServiceWorkOrderRepository,
    private readonly requestRows: RequestRepository,
    private readonly customers: CustomerRepository,
    private readonly companies: CompanyRepository,
    private readonly configs: CrmConfigRepository,
    private readonly people: CompanyMemberRepository,
    private readonly sender: SurveySender,
    private readonly events: DomainEventsService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    this.events.on(DOMAIN_EVENTS.requestCompleted, (event) => {
      const payload = event.payload as { request_id?: string };
      if (!payload.request_id) return Promise.resolve();
      return this.onDone(payload.request_id)
        .then(() => undefined)
        .catch((error: Error) =>
          this.logger.warn(`survey not started: ${error.message}`),
        );
    });
  }

  /** A service job's case is done: its survey, once. Null for other cases. */
  async onDone(requestId: string, now = new Date()) {
    const order = (await this.orders.findFirst({
      where: { requestId },
      select: { id: true, companyId: true, customerId: true },
    })) as { id: string; companyId: string; customerId: string | null } | null;
    if (!order) return null;
    if (await this.surveys.count({ where: { workOrderId: order.id } })) {
      return null;
    }
    const request = await this.caseOf(requestId);
    const { token, hash } = newToken();
    const expiresAt = expiryFrom(now);
    const delivery = await this.deliver(order, request, token, expiresAt);
    const row = (await this.surveys
      .create({
        data: {
          companyId: order.companyId,
          workOrderId: order.id,
          requestId,
          customerId: order.customerId,
          assigneeUserId: request.assigneeUserId,
          tokenHash: hash,
          expiresAt,
          sentVia: delivery.via,
          sentTo: delivery.to,
          sentAt: delivery.delivered ? now : null,
        },
      })
      .catch(() => null)) as SurveyRow | null;
    return row ? { id: row.id, link: this.link(token), delivery } : null;
  }

  /**
   * A fresh link (the old one stops working), shown once — for the team to
   * copy when nothing could be sent, or after it expired unanswered.
   */
  async reissue(actor: Principal, workOrderId: string, now = new Date()) {
    const companyId = actor.activeCompanyId;
    const order = (await this.orders.findFirst({
      where: { id: workOrderId, companyId },
      select: { id: true, companyId: true, customerId: true, requestId: true },
    })) as {
      id: string;
      companyId: string;
      customerId: string | null;
      requestId: string;
    } | null;
    if (!order) throw new AppError('NOT_FOUND', 'ไม่พบใบสั่งงานบริการ');
    const request = await this.caseOf(order.requestId);
    if (!['completed', 'approved', 'closed'].includes(request.status)) {
      throw new AppError('CONFLICT', 'ส่งแบบประเมินได้เมื่องานเสร็จแล้ว');
    }
    const existing = (await this.surveys.findFirst({
      where: { workOrderId },
    })) as SurveyRow | null;
    if (existing?.answeredAt) {
      throw new AppError('CONFLICT', 'ลูกค้าตอบแบบประเมินนี้แล้ว');
    }
    const { token, hash } = newToken();
    const expiresAt = expiryFrom(now);
    await this.transactions.execute(async (prisma) => {
      await prisma.serviceSurvey.upsert({
        where: { workOrderId },
        create: {
          companyId,
          workOrderId,
          requestId: order.requestId,
          customerId: order.customerId,
          assigneeUserId: request.assigneeUserId,
          tokenHash: hash,
          expiresAt,
        },
        update: { tokenHash: hash, expiresAt },
      });
      await this.audit.record(
        {
          eventType: 'service.survey.reissued',
          companyId,
          ...auditActor(actor),
          resourceType: 'service_work_order',
          resourceId: workOrderId,
          after: { expiresAt: expiresAt.toISOString() },
        },
        { prisma },
      );
    });
    return { link: this.link(token), expiresAt: expiresAt.toISOString() };
  }

  /** What the customer sees at the link. */
  async publicView(token: string, now = new Date()) {
    const row = await this.byToken(token);
    const [request, company] = await Promise.all([
      this.caseOf(row.requestId),
      this.companyName(row.companyId),
    ]);
    return {
      companyName: company,
      requestNo: request.requestNo,
      subject: subjectOf(request),
      doneOn: iso(request.completedAt)?.slice(0, 10) ?? null,
      state: surveyState(row, now),
    };
  }

  /** The customer's answer — once, before it expires. */
  async answer(token: string, dto: SurveyAnswer, now = new Date()) {
    const row = await this.byToken(token);
    const state = surveyState(row, now);
    if (state === 'answered') {
      throw new AppError('CONFLICT', 'แบบประเมินนี้ตอบแล้ว ขอบคุณครับ');
    }
    if (state === 'expired') {
      throw new AppError('CONFLICT', 'ลิงก์แบบประเมินหมดอายุแล้ว');
    }
    const problems = answerProblems(dto);
    if (problems.length) throw new AppError('VALIDATION_FAILED', problems[0]);
    const claimed = await this.surveys.updateMany({
      where: { id: row.id, answeredAt: null },
      data: {
        answeredAt: now,
        overall: dto.overall,
        speed: dto.speed ?? null,
        technician: dto.technician ?? null,
        outcome: dto.outcome ?? null,
        comment: dto.comment?.trim() || null,
      },
    });
    if (claimed.count !== 1) {
      throw new AppError('CONFLICT', 'แบบประเมินนี้ตอบแล้ว ขอบคุณครับ');
    }
    await this.audit.record({
      eventType: 'service.survey.answered',
      companyId: row.companyId,
      actorId: null,
      actorUsername: 'customer-survey',
      resourceType: 'service_work_order',
      resourceId: row.workOrderId,
      after: { overall: dto.overall },
    });
    if (isLow(dto.overall)) await this.alertLow(row, dto, now);
    return { ok: true };
  }

  /** The job's survey on its panel. */
  async ofWorkOrder(actor: Principal, workOrderId: string, now = new Date()) {
    const row = (await this.surveys.findFirst({
      where: { workOrderId, companyId: actor.activeCompanyId },
    })) as SurveyRow | null;
    return row ? this.view(row, now) : null;
  }

  /** Answers and the team's figures, per month and per technician. */
  async list(actor: Principal, query: ListSurveysQueryDto, now = new Date()) {
    const from = query.from
      ? new Date(`${query.from}T00:00:00Z`)
      : new Date(now.getTime() - 180 * 86_400_000);
    const rows = (await this.surveys.findMany({
      where: { companyId: actor.activeCompanyId, createdAt: { gte: from } },
      orderBy: [{ createdAt: 'desc' }],
      take: 1000,
    })) as SurveyRow[];
    const facts = rows.map((row) => ({
      sentAt: row.sentAt,
      answeredAt: row.answeredAt,
      overall: row.overall,
      speed: row.speed,
      technician: row.technician,
      outcome: row.outcome,
      assigneeUserId: row.assigneeUserId,
      month: row.createdAt.toISOString().slice(0, 7),
    }));
    const names = await this.names(rows.map((row) => row.assigneeUserId));
    const views = await Promise.all(
      rows
        .filter((row) => row.answeredAt)
        .slice(0, 200)
        .map((row) => this.view(row, now)),
    );
    return {
      total: surveyFigures(facts),
      byMonth: groupFigures(facts, (row) => row.month).sort((a, b) =>
        a.key.localeCompare(b.key),
      ),
      byTechnician: groupFigures(facts, (row) => row.assigneeUserId).map(
        (group) => ({ ...group, name: names.get(group.key) ?? group.key }),
      ),
      answers: views,
    };
  }

  // --- helpers ---------------------------------------------------------------

  private async deliver(
    order: { companyId: string; customerId: string | null },
    request: CaseRow,
    token: string,
    expiresAt: Date,
  ) {
    const [company, customer] = await Promise.all([
      this.companies.findFirst({
        where: { id: order.companyId },
        select: { code: true, name: true },
      }) as Promise<{ code: string; name: string } | null>,
      order.customerId
        ? (this.customers.findFirst({
            where: { id: order.customerId },
            select: { nameTh: true },
          }) as Promise<{ nameTh: string } | null>)
        : Promise.resolve(null),
    ]);
    return this.sender.send(
      {
        name: request.contactName,
        email: request.contactEmail,
        lineUserId: request.contactLineUserId,
      },
      {
        companyCode: company?.code ?? '',
        customerName: customer?.nameTh ?? '',
        subject: subjectOf(request),
        link: this.link(token),
        expiresAt,
      },
    );
  }

  /** Overall low: the account owner (and whoever opened the job) follow up. */
  private async alertLow(row: SurveyRow, dto: SurveyAnswer, now: Date) {
    const claimed = await this.surveys.updateMany({
      where: { id: row.id, lowAlertedAt: null },
      data: { lowAlertedAt: now },
    });
    if (claimed.count !== 1) return;
    const [customer, order, request] = await Promise.all([
      row.customerId
        ? (this.customers.findFirst({
            where: { id: row.customerId },
            select: { nameTh: true, accountOwnerUserId: true },
          }) as Promise<{
            nameTh: string;
            accountOwnerUserId: string | null;
          } | null>)
        : Promise.resolve(null),
      this.orders.findFirst({
        where: { id: row.workOrderId },
        select: { createdBy: true },
      }) as Promise<{ createdBy: string } | null>,
      this.caseOf(row.requestId),
    ]);
    const to = [
      ...new Set(
        [customer?.accountOwnerUserId, order?.createdBy].filter(
          (id): id is string => Boolean(id),
        ),
      ),
    ];
    for (const userId of to) {
      await this.notifications
        .surveyLow(userId, row.companyId, {
          requestId: row.requestId,
          requestNo: request.requestNo,
          customer: customer?.nameTh ?? '',
          overall: dto.overall,
          comment: dto.comment?.trim() ?? '',
        })
        .catch((error: Error) =>
          this.logger.warn(`low survey notice not sent: ${error.message}`),
        );
    }
  }

  private link(token: string) {
    const base =
      this.config.get<string>('service.surveyPublicUrl') ??
      'http://localhost:3000';
    return `${base.replace(/\/$/, '')}/s/${token}`;
  }

  private async byToken(token: string) {
    const row = (await this.surveys.findFirst({
      where: { tokenHash: tokenHash(token) },
    })) as SurveyRow | null;
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบแบบประเมินนี้');
    return row;
  }

  private async caseOf(requestId: string) {
    const row = (await this.requestRows.findFirst({
      where: { id: requestId },
      select: {
        id: true,
        companyId: true,
        requestNo: true,
        status: true,
        assigneeUserId: true,
        contactName: true,
        contactEmail: true,
        contactLineUserId: true,
        formData: true,
        completedAt: true,
      },
    })) as CaseRow | null;
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบคำขอ');
    return row;
  }

  private async companyName(companyId: string) {
    const [company, letterhead] = await Promise.all([
      this.companies.findFirst({
        where: { id: companyId },
        select: { name: true },
      }) as Promise<{ name: string } | null>,
      this.configs.findFirst({
        where: { companyId },
        select: { letterheadNameTh: true },
      }) as Promise<{ letterheadNameTh: string | null } | null>,
    ]);
    return letterhead?.letterheadNameTh || company?.name || '';
  }

  private async view(row: SurveyRow, now: Date) {
    const [request, names] = await Promise.all([
      this.caseOf(row.requestId).catch(() => null),
      this.names([row.assigneeUserId]),
    ]);
    return {
      id: row.id,
      workOrderId: row.workOrderId,
      requestId: row.requestId,
      requestNo: request?.requestNo ?? null,
      subject: subjectOf(request),
      technicianName: row.assigneeUserId
        ? (names.get(row.assigneeUserId) ?? row.assigneeUserId)
        : null,
      state: surveyState(row, now),
      sentVia: row.sentVia,
      sentTo: row.sentTo,
      sentAt: iso(row.sentAt),
      expiresAt: row.expiresAt.toISOString(),
      answeredAt: iso(row.answeredAt),
      overall: row.overall,
      speed: row.speed,
      technician: row.technician,
      outcome: row.outcome,
      comment: row.comment,
    };
  }

  private async names(ids: (string | null)[]) {
    const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
    if (!unique.length) return new Map<string, string>();
    const users = (await this.people.findMany({
      where: { id: { in: unique } },
      select: { id: true, displayName: true },
    })) as { id: string; displayName: string }[];
    return new Map(users.map((user) => [user.id, user.displayName]));
  }
}
