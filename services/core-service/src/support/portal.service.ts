import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AppError,
  AuditWriter,
  auditActor,
  OBJECT_STORAGE,
  Principal,
  PrismaTransactionService,
} from '@request-management/share';
import type { ObjectStorage } from '@request-management/share';
import { CustomerRepository } from '../crm/customer.repository';
import { CrmConfigRepository } from '../crm/segment.repositories';
import { RequestRepository } from '../requests/request.repository';
import { PmPlanService } from './pm-plan.service';
import {
  caseProblems,
  customerStatus,
  inviteExpiry,
  inviteState,
  sessionExpiry,
  type PortalCase,
} from './portal-rules';
import { newToken, tokenHash } from './survey-rules';
import { InvitePortalContactDto } from './support.dto';
import {
  ServiceAssetRepository,
  ServiceEntitlementAssetRepository,
  ServiceEntitlementRepository,
  ServicePortalContactRepository,
  ServicePortalSessionRepository,
  ServiceReportRepository,
  ServiceWorkOrderRepository,
} from './support.repositories';
import { WorkOrdersService } from './work-orders.service';

interface ContactRow {
  id: string;
  companyId: string;
  customerId: string;
  name: string;
  email: string | null;
  phone: string | null;
  inviteHash: string | null;
  inviteExpires: Date | null;
  invitedAt: Date;
  lastSeenAt: Date | null;
  revokedAt: Date | null;
}

export interface PortalViewer {
  contactId: string;
  companyId: string;
  customerId: string;
  name: string;
}

const day = (value: Date | null) =>
  value ? value.toISOString().slice(0, 10) : null;

/**
 * CD-249 Customer Portal — a customer's people see their own installed base,
 * its covers, their service jobs and the service reports sent to them, and
 * raise a case on their equipment.
 *
 * Getting in, with no password anywhere (AGENTS.md): the service team
 * invites a contact; the private invite link (only its SHA-256 kept, 90
 * days, revoked or reissued at will) opens an 8-hour session whose token
 * the web app keeps in an httpOnly cookie. Every read is pinned to the
 * session's customer. A case is raised as a service job (CD-239) under the
 * company's portal user, as a CD-66 channel's requester is, with the contact
 * on the case.
 *
 * The public routes are core-service's third public business surface
 * (AGENTS.md). Staff: `service.asset.read` lists contacts,
 * `service.asset.manage` invites and revokes.
 */
@Injectable()
export class PortalService {
  constructor(
    private readonly contacts: ServicePortalContactRepository,
    private readonly sessions: ServicePortalSessionRepository,
    private readonly customers: CustomerRepository,
    private readonly assetRows: ServiceAssetRepository,
    private readonly entitlements: ServiceEntitlementRepository,
    private readonly entitlementAssets: ServiceEntitlementAssetRepository,
    private readonly orders: ServiceWorkOrderRepository,
    private readonly reports: ServiceReportRepository,
    private readonly requestRows: RequestRepository,
    private readonly configs: CrmConfigRepository,
    private readonly workOrders: WorkOrdersService,
    private readonly pm: PmPlanService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
    private readonly config: ConfigService,
  ) {}

  // --- staff -----------------------------------------------------------------

  async contactsOf(actor: Principal, customerId: string, now = new Date()) {
    const rows = (await this.contacts.findMany({
      where: { companyId: actor.activeCompanyId, customerId },
      orderBy: { invitedAt: 'desc' },
    })) as ContactRow[];
    return rows.map((row) => this.contactView(row, now));
  }

  /** A new contact and their invite link (shown once). */
  async invite(
    actor: Principal,
    dto: InvitePortalContactDto,
    now = new Date(),
  ) {
    const companyId = actor.activeCompanyId;
    const customer = await this.customers.findFirst({
      where: { id: dto.customer_id, companyId },
      select: { id: true },
    });
    if (!customer) throw new AppError('NOT_FOUND', 'ไม่พบลูกค้า');
    const { token, hash } = newToken();
    const row = await this.transactions.execute(async (prisma) => {
      const created = await prisma.servicePortalContact.create({
        data: {
          companyId,
          customerId: dto.customer_id,
          name: dto.name.trim(),
          email: dto.email?.trim() || null,
          phone: dto.phone?.trim() || null,
          inviteHash: hash,
          inviteExpires: inviteExpiry(now),
          invitedBy: actor.userId,
        },
      });
      await this.audit.record(
        {
          eventType: 'service.portal.invited',
          companyId,
          ...auditActor(actor),
          resourceType: 'service_portal_contact',
          resourceId: created.id,
          after: { customerId: dto.customer_id, name: dto.name.trim() },
        },
        { prisma },
      );
      return created;
    });
    return { contact: this.contactView(row, now), link: this.link(token) };
  }

  /** A fresh link (the old one and its sessions stop working), shown once. */
  async reinvite(actor: Principal, contactId: string, now = new Date()) {
    const contact = await this.requireContact(actor.activeCompanyId, contactId);
    const { token, hash } = newToken();
    await this.transactions.execute(async (prisma) => {
      await prisma.servicePortalContact.update({
        where: { id: contactId },
        data: {
          inviteHash: hash,
          inviteExpires: inviteExpiry(now),
          revokedAt: null,
          revokedBy: null,
        },
      });
      await prisma.servicePortalSession.deleteMany({ where: { contactId } });
      await this.audit.record(
        {
          eventType: 'service.portal.reinvited',
          companyId: contact.companyId,
          ...auditActor(actor),
          resourceType: 'service_portal_contact',
          resourceId: contactId,
        },
        { prisma },
      );
    });
    return { link: this.link(token) };
  }

  /** Out: the link and every open session stop at once. */
  async revoke(actor: Principal, contactId: string, now = new Date()) {
    const contact = await this.requireContact(actor.activeCompanyId, contactId);
    await this.transactions.execute(async (prisma) => {
      await prisma.servicePortalContact.update({
        where: { id: contactId },
        data: { revokedAt: now, revokedBy: actor.userId, inviteHash: null },
      });
      await prisma.servicePortalSession.deleteMany({ where: { contactId } });
      await this.audit.record(
        {
          eventType: 'service.portal.revoked',
          companyId: contact.companyId,
          ...auditActor(actor),
          resourceType: 'service_portal_contact',
          resourceId: contactId,
        },
        { prisma },
      );
    });
    return this.contactView(
      { ...contact, revokedAt: now, inviteHash: null },
      now,
    );
  }

  // --- the customer's side ---------------------------------------------------

  /** The invite link opens a session (its token goes to an httpOnly cookie). */
  async openSession(invite: string, now = new Date()) {
    const contact = (await this.contacts.findFirst({
      where: { inviteHash: tokenHash(invite) },
    })) as ContactRow | null;
    if (!contact || inviteState(contact, now) !== 'active') {
      throw new AppError(
        'NOT_FOUND',
        'ลิงก์เข้าใช้งานไม่ถูกต้องหรือหมดอายุแล้ว',
      );
    }
    const { token, hash } = newToken();
    const expiresAt = sessionExpiry(now);
    await this.sessions.create({
      data: { contactId: contact.id, tokenHash: hash, expiresAt },
    });
    await this.contacts.update({
      where: { id: contact.id },
      data: { lastSeenAt: now },
    });
    return { session: token, expiresAt: expiresAt.toISOString() };
  }

  async closeSession(session: string) {
    await this.transactions.execute((prisma) =>
      prisma.servicePortalSession.deleteMany({
        where: { tokenHash: tokenHash(session) },
      }),
    );
    return { ok: true };
  }

  /** The viewer behind a session token, or 401. */
  async viewer(
    session: string | undefined,
    now = new Date(),
  ): Promise<PortalViewer> {
    if (!session)
      throw new AppError('UNAUTHORIZED', 'กรุณาเข้าจากลิงก์ที่ได้รับ');
    const row = (await this.sessions.findFirst({
      where: { tokenHash: tokenHash(session), expiresAt: { gt: now } },
      select: { contactId: true },
    })) as { contactId: string } | null;
    const contact = row
      ? ((await this.contacts.findFirst({
          where: { id: row.contactId, revokedAt: null },
        })) as ContactRow | null)
      : null;
    if (!contact) {
      throw new AppError(
        'UNAUTHORIZED',
        'หมดเวลาใช้งาน กรุณาเข้าจากลิงก์อีกครั้ง',
      );
    }
    return {
      contactId: contact.id,
      companyId: contact.companyId,
      customerId: contact.customerId,
      name: contact.name,
    };
  }

  async me(viewer: PortalViewer) {
    const customer = (await this.customers.findFirst({
      where: { id: viewer.customerId },
      select: { customerCode: true, nameTh: true },
    })) as { customerCode: string; nameTh: string } | null;
    const config = (await this.configs.findFirst({
      where: { companyId: viewer.companyId },
      select: { servicePortalUserId: true, letterheadNameTh: true },
    })) as {
      servicePortalUserId: string | null;
      letterheadNameTh: string | null;
    } | null;
    return {
      contactName: viewer.name,
      customer: customer
        ? { code: customer.customerCode, name: customer.nameTh }
        : null,
      providerName: config?.letterheadNameTh ?? null,
      canRaise: Boolean(config?.servicePortalUserId),
    };
  }

  async assets(viewer: PortalViewer) {
    const rows = (await this.assetRows.findMany({
      where: {
        companyId: viewer.companyId,
        customerId: viewer.customerId,
        status: 'active',
      },
      orderBy: [{ name: 'asc' }],
      select: {
        id: true,
        kind: true,
        name: true,
        model: true,
        serialNo: true,
        location: true,
        installedOn: true,
      },
      take: 1000,
    })) as {
      id: string;
      kind: string;
      name: string;
      model: string | null;
      serialNo: string | null;
      location: string | null;
      installedOn: Date | null;
    }[];
    return rows.map((row) => ({ ...row, installedOn: day(row.installedOn) }));
  }

  async covers(viewer: PortalViewer) {
    const rows = (await this.entitlements.findMany({
      where: {
        companyId: viewer.companyId,
        customerId: viewer.customerId,
        cancelledAt: null,
      },
      orderBy: [{ endOn: 'desc' }],
      select: {
        id: true,
        kind: true,
        title: true,
        startOn: true,
        endOn: true,
        coverage: true,
      },
    })) as {
      id: string;
      kind: string;
      title: string;
      startOn: Date;
      endOn: Date;
      coverage: string | null;
    }[];
    const counts = new Map<string, number>();
    for (const link of (await this.entitlementAssets.findMany({
      where: { entitlementId: { in: rows.map((r) => r.id) }, removedAt: null },
      select: { entitlementId: true },
    })) as { entitlementId: string }[]) {
      counts.set(link.entitlementId, (counts.get(link.entitlementId) ?? 0) + 1);
    }
    const today = new Date().toISOString().slice(0, 10);
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      title: row.title,
      startOn: day(row.startOn),
      endOn: day(row.endOn),
      coverage: row.coverage,
      active: day(row.startOn)! <= today && day(row.endOn)! >= today,
      assets: counts.get(row.id) ?? 0,
    }));
  }

  async jobs(viewer: PortalViewer) {
    const orders = (await this.orders.findMany({
      where: { companyId: viewer.companyId, customerId: viewer.customerId },
      orderBy: [{ createdAt: 'desc' }],
      select: {
        id: true,
        requestId: true,
        workKind: true,
        assetId: true,
        createdAt: true,
      },
      take: 200,
    })) as {
      id: string;
      requestId: string;
      workKind: string;
      assetId: string | null;
      createdAt: Date;
    }[];
    const [cases, assets] = await Promise.all([
      this.requestRows.findMany({
        where: { id: { in: orders.map((o) => o.requestId) } },
        select: {
          id: true,
          requestNo: true,
          status: true,
          severity: true,
          formData: true,
          submittedAt: true,
          completedAt: true,
        },
      }) as Promise<
        {
          id: string;
          requestNo: string | null;
          status: string;
          severity: string | null;
          formData: unknown;
          submittedAt: Date | null;
          completedAt: Date | null;
        }[]
      >,
      this.assetRows.findMany({
        where: {
          id: { in: orders.flatMap((o) => (o.assetId ? [o.assetId] : [])) },
        },
        select: { id: true, name: true, serialNo: true },
      }) as Promise<{ id: string; name: string; serialNo: string | null }[]>,
    ]);
    const caseById = new Map(cases.map((row) => [row.id, row]));
    const assetById = new Map(assets.map((row) => [row.id, row]));
    return orders.flatMap((order) => {
      const request = caseById.get(order.requestId);
      if (!request) return [];
      const form = (request.formData ?? {}) as { subject?: unknown };
      const asset = order.assetId ? assetById.get(order.assetId) : undefined;
      return [
        {
          id: order.id,
          requestNo: request.requestNo,
          subject: typeof form.subject === 'string' ? form.subject : '',
          workKind: order.workKind,
          severity: request.severity,
          status: customerStatus(request.status),
          asset: asset
            ? [asset.name, asset.serialNo].filter(Boolean).join(' · ')
            : null,
          openedOn: day(request.submittedAt ?? order.createdAt),
          doneOn: day(request.completedAt),
        },
      ];
    });
  }

  /** A case on their equipment — a service job under the portal user. */
  async raise(viewer: PortalViewer, dto: PortalCase & { asset_id?: string }) {
    const problems = caseProblems(dto);
    if (problems.length) throw new AppError('VALIDATION_FAILED', problems[0]);
    const config = (await this.configs.findFirst({
      where: { companyId: viewer.companyId },
      select: { servicePortalUserId: true },
    })) as { servicePortalUserId: string | null } | null;
    if (!config?.servicePortalUserId) {
      throw new AppError(
        'CONFLICT',
        'ยังไม่เปิดให้แจ้งเหตุผ่าน portal กรุณาติดต่อผู้ให้บริการ',
      );
    }
    if (dto.asset_id) {
      const asset = await this.assetRows.findFirst({
        where: { id: dto.asset_id, customerId: viewer.customerId },
        select: { id: true },
      });
      if (!asset) throw new AppError('NOT_FOUND', 'ไม่พบอุปกรณ์นี้');
    }
    const contact = (await this.contacts.findFirst({
      where: { id: viewer.contactId },
    })) as ContactRow;
    const principal = await this.pm.principalOf(
      config.servicePortalUserId,
      viewer.companyId,
    );
    const order = (await this.workOrders.open(
      principal,
      {
        customer_id: viewer.customerId,
        ...(dto.asset_id ? { asset_id: dto.asset_id } : {}),
        work_kind: 'corrective',
        severity: dto.severity,
        subject: dto.subject.trim(),
        detail: [
          dto.detail?.trim(),
          `แจ้งผ่าน Customer Portal โดย ${contact.name}`,
        ]
          .filter(Boolean)
          .join('\n'),
      },
      '',
    )) as {
      id: string;
      requestId: string;
      request: { requestNo: string | null } | null;
    };
    await this.requestRows.update({
      where: { id: order.requestId },
      data: {
        contactName: contact.name,
        contactEmail: contact.email,
        contactPhone: contact.phone,
      },
    });
    await this.audit.record({
      eventType: 'service.portal.case_raised',
      companyId: viewer.companyId,
      actorId: null,
      actorUsername: `portal:${contact.id}`,
      resourceType: 'request',
      resourceId: order.requestId,
      after: { workOrderId: order.id, contactId: contact.id },
    });
    return { id: order.id, requestNo: order.request?.requestNo ?? null };
  }

  /** Service reports sent to them (CD-247). */
  async reportsOf(viewer: PortalViewer) {
    const rows = (await this.reports.findMany({
      where: {
        companyId: viewer.companyId,
        customerId: viewer.customerId,
        sentOn: { not: null },
      },
      orderBy: [{ periodFrom: 'desc' }],
      select: {
        id: true,
        reportNo: true,
        periodFrom: true,
        periodTo: true,
        data: true,
      },
    })) as {
      id: string;
      reportNo: string;
      periodFrom: Date;
      periodTo: Date;
      data: unknown;
    }[];
    return rows.map((row) => ({
      id: row.id,
      reportNo: row.reportNo,
      periodFrom: day(row.periodFrom),
      periodTo: day(row.periodTo),
      title:
        (row.data as { entitlement?: { title?: string } }).entitlement?.title ??
        '',
    }));
  }

  async reportFile(viewer: PortalViewer, id: string) {
    const row = (await this.reports.findFirst({
      where: {
        id,
        companyId: viewer.companyId,
        customerId: viewer.customerId,
        sentOn: { not: null },
      },
      select: { reportNo: true, pdfKey: true },
    })) as { reportNo: string; pdfKey: string } | null;
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบรายงาน');
    return {
      stream: await this.storage.get(row.pdfKey),
      fileName: `${row.reportNo}.pdf`,
    };
  }

  // --- helpers ---------------------------------------------------------------

  private contactView(row: ContactRow, now: Date) {
    return {
      id: row.id,
      customerId: row.customerId,
      name: row.name,
      email: row.email,
      phone: row.phone,
      invitedAt: row.invitedAt.toISOString(),
      inviteExpires: row.inviteExpires?.toISOString() ?? null,
      lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
      state: inviteState(row, now),
    };
  }

  private link(token: string) {
    const base =
      this.config.get<string>('service.surveyPublicUrl') ??
      'http://localhost:3000';
    return `${base.replace(/\/$/, '')}/f/portal/enter/${token}`;
  }

  private async requireContact(companyId: string, id: string) {
    const row = (await this.contacts.findFirst({
      where: { id, companyId },
    })) as ContactRow | null;
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบผู้ติดต่อ');
    return row;
  }
}
