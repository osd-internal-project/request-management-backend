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
  hasPermission,
  Principal,
  PrismaService,
} from '@request-management/share';
import { backgroundTick } from '../common/background-tick';
import { NotificationRulesService } from '../notifications/notification-rules.service';
import { NotificationsService } from '../notifications/notifications.service';
import { DeliveriesService } from './deliveries.service';

const RULE = 'service.handover';
const DEFAULT_INTERVAL_MS = 3 * 3_600_000;
const DAY_MS = 86_400_000;
const day = (value: Date) => value.toISOString().slice(0, 10);

interface RoundRow {
  id: string;
  seq: number;
  milestoneId: string | null;
  status: string;
  decidedOn: Date | null;
}

interface HandoverRow {
  id: string;
  companyId: string;
  projectId: string;
  acceptanceId: string;
  status: string;
  note: string;
  sentBy: string;
  sentAt: Date;
  question: string | null;
  questionedBy: string | null;
  questionedAt: Date | null;
  acknowledgedBy: string | null;
  acknowledgedAt: Date | null;
  ackNote: string | null;
  remindedAt: Date | null;
}

/**
 * CD-255 ส่งมอบให้ทีมบริการ (part of CD-20 Delivery).
 *
 * After a phase is accepted, the delivery team hands the service team what it
 * needs to look after the customer from then on: the equipment registered at
 * acceptance (CD-236), the warranty it started (CD-237 — read, never worked
 * out again here), the service levels in the contract, the delivery documents
 * and the signed certificate (CD-251/252), the customer's contacts, and the
 * open points still owed. The service team acknowledges it, or sends a
 * question back that the delivery team answers by sending again; one left
 * unacknowledged is chased every few days (the `service.handover` rule).
 *
 * Who: the delivery team, PM or the project's manager sends; the service
 * team (`service.asset.manage`) acknowledges or asks; either team reads.
 */
@Injectable()
export class ServiceHandoversService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ServiceHandoversService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly deliveries: DeliveriesService,
    private readonly prisma: PrismaService,
    private readonly rules: NotificationRulesService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditWriter,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const interval =
      this.config.get<number>('delivery.handoverIntervalMs') ??
      DEFAULT_INTERVAL_MS;
    if (interval <= 0) return;
    this.timer = setInterval(
      backgroundTick(this.logger, 'CD-255 service handover reminder', () =>
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

  /** A project's accepted rounds with their handover and what it carries. */
  async projectView(actor: Principal, projectId: string) {
    const { canEdit } = await this.deliveries.access(actor, projectId);
    const rounds = await this.acceptedRounds(projectId);
    const handovers = (await this.prisma.serviceHandover.findMany({
      where: { projectId },
    })) as HandoverRow[];
    const names = await this.names(handovers);
    return {
      canSend: canEdit,
      rounds: await Promise.all(
        rounds.map(async (round) => ({
          acceptanceId: round.id,
          label: `A-${round.seq}`,
          decidedOn: round.decidedOn ? day(round.decidedOn) : null,
          package: await this.packageOf(projectId, round),
          handover: this.handoverView(
            handovers.find((h) => h.acceptanceId === round.id) ?? null,
            names,
          ),
        })),
      ),
    };
  }

  /** The service team's inbox: what was handed over (pending first). */
  async inbox(actor: Principal, status?: string) {
    this.assertReader(actor);
    const rows = (await this.prisma.serviceHandover.findMany({
      where: {
        companyId: actor.activeCompanyId,
        ...(status ? { status } : {}),
      },
      orderBy: [{ sentAt: 'desc' }],
      take: 200,
    })) as HandoverRow[];
    const projects = await this.prisma.project.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.projectId))] } },
      select: { id: true, projectNo: true, name: true },
    });
    const rounds = await this.prisma.projectAcceptance.findMany({
      where: { id: { in: rows.map((r) => r.acceptanceId) } },
      select: {
        id: true,
        seq: true,
        milestoneId: true,
        status: true,
        decidedOn: true,
      },
    });
    const names = await this.names(rows);
    const order: Record<string, number> = {
      sent: 0,
      questioned: 1,
      acknowledged: 2,
    };
    const items = await Promise.all(
      rows.map(async (row) => {
        const project = projects.find((p) => p.id === row.projectId);
        const round = rounds.find((r) => r.id === row.acceptanceId);
        return {
          project: project
            ? {
                id: project.id,
                label: `${project.projectNo} · ${project.name}`,
              }
            : null,
          round: round ? `A-${round.seq}` : null,
          decidedOn: round?.decidedOn ? day(round.decidedOn) : null,
          package: round ? await this.packageOf(row.projectId, round) : null,
          ...this.handoverView(row, names)!,
        };
      }),
    );
    return {
      canAcknowledge: hasPermission(actor, 'service.asset.manage'),
      items: items.sort(
        (a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9),
      ),
    };
  }

  /** Hand a round over (again, after a question). */
  async send(
    actor: Principal,
    projectId: string,
    acceptanceId: string,
    note: string,
  ) {
    const { project, canEdit } = await this.deliveries.access(actor, projectId);
    if (!canEdit) {
      throw new AppError(
        'FORBIDDEN',
        'ส่งต่อได้เฉพาะทีม Delivery หรือผู้จัดการโครงการ',
      );
    }
    const round = (await this.acceptedRounds(projectId)).find(
      (r) => r.id === acceptanceId,
    );
    if (!round) {
      throw new AppError(
        'CONFLICT',
        'ส่งต่อได้เฉพาะรอบตรวจรับที่บันทึกผลรับมอบแล้ว',
      );
    }
    const existing = (await this.prisma.serviceHandover.findUnique({
      where: { acceptanceId },
    })) as HandoverRow | null;
    if (existing?.status === 'acknowledged') {
      throw new AppError('CONFLICT', 'ทีมบริการรับทราบแล้ว');
    }
    if (existing?.status === 'sent') {
      throw new AppError('CONFLICT', 'ส่งต่อแล้ว รอทีมบริการรับทราบ');
    }
    const pack = await this.packageOf(projectId, round);
    const snapshot = {
      assetIds: pack.assets.map((a) => a.id),
      entitlementIds: pack.warranties.map((w) => w.id),
      documentIds: pack.documents.map((d: { id: string }) => d.id),
      certificateId: pack.certificate?.id ?? null,
      contactIds: pack.contacts.map((c: { id: string }) => c.id),
      openPoints: pack.openPoints.length,
    };
    const data = {
      status: 'sent',
      note: note.trim(),
      snapshot,
      sentBy: actor.userId,
      sentAt: new Date(),
      remindedAt: null,
    };
    await this.prisma.serviceHandover.upsert({
      where: { acceptanceId },
      create: {
        companyId: project.companyId,
        projectId,
        acceptanceId,
        milestoneId: round.milestoneId,
        ...data,
      },
      update: data,
    });
    await this.audit.record({
      eventType: existing
        ? 'delivery.handover.resent'
        : 'delivery.handover.sent',
      companyId: project.companyId,
      ...auditActor(actor),
      resourceType: 'project',
      resourceId: projectId,
      after: { acceptanceId, ...snapshot },
    });
    const label = `${project.projectNo} · ${project.name}`;
    for (const userId of await this.serviceTeam(project.companyId)) {
      if (userId === actor.userId) continue;
      await this.notifications.serviceHandover(
        userId,
        project.companyId,
        { id: projectId, label },
        `A-${round.seq}`,
        'sent',
        note.trim(),
      );
    }
    return this.projectView(actor, projectId);
  }

  async acknowledge(actor: Principal, id: string, note: string) {
    const row = await this.forServiceTeam(actor, id);
    if (row.status !== 'sent')
      throw new AppError('CONFLICT', 'รายการนี้ไม่ได้รอรับทราบ');
    await this.prisma.serviceHandover.update({
      where: { id },
      data: {
        status: 'acknowledged',
        acknowledgedBy: actor.userId,
        acknowledgedAt: new Date(),
        ackNote: note.trim() || null,
      },
    });
    await this.tell(row, actor, 'acknowledged', note.trim());
    return this.inbox(actor);
  }

  async ask(actor: Principal, id: string, question: string) {
    const row = await this.forServiceTeam(actor, id);
    if (row.status !== 'sent')
      throw new AppError('CONFLICT', 'รายการนี้ไม่ได้รอรับทราบ');
    if (!question.trim())
      throw new AppError('VALIDATION_FAILED', 'ต้องระบุคำถาม');
    await this.prisma.serviceHandover.update({
      where: { id },
      data: {
        status: 'questioned',
        question: question.trim(),
        questionedBy: actor.userId,
        questionedAt: new Date(),
      },
    });
    await this.tell(row, actor, 'questioned', question.trim());
    return this.inbox(actor);
  }

  /** Chase what the service team has not acknowledged after `days` days. */
  async sweep(now: Date = new Date()): Promise<{ reminded: number }> {
    const rule = await this.rules.across(RULE);
    if (![rule.standard, ...rule.byCompany.values()].some((r) => r.enabled))
      return { reminded: 0 };
    const rows = (await this.prisma.serviceHandover.findMany({
      where: { status: 'sent' },
    })) as HandoverRow[];
    let reminded = 0;
    const teams = new Map<string, string[]>();
    for (const row of rows) {
      const own = rule.of(row.companyId);
      if (!own.enabled) continue;
      const days = typeof own.params.days === 'number' ? own.params.days : 3;
      const since = (row.remindedAt ?? row.sentAt).getTime();
      if (now.getTime() - since < days * DAY_MS) continue;
      const claimed = await this.prisma.serviceHandover.updateMany({
        where: { id: row.id, status: 'sent', remindedAt: row.remindedAt },
        data: { remindedAt: now },
      });
      if (!claimed.count) continue;
      if (!teams.has(row.companyId))
        teams.set(row.companyId, await this.serviceTeam(row.companyId));
      const project = await this.prisma.project.findUnique({
        where: { id: row.projectId },
        select: { projectNo: true, name: true },
      });
      const round = await this.prisma.projectAcceptance.findUnique({
        where: { id: row.acceptanceId },
        select: { seq: true },
      });
      for (const userId of teams.get(row.companyId) ?? []) {
        await this.notifications.serviceHandover(
          userId,
          row.companyId,
          {
            id: row.projectId,
            label: `${project?.projectNo} · ${project?.name}`,
          },
          `A-${round?.seq ?? '?'}`,
          'overdue',
          row.note,
        );
      }
      reminded += 1;
    }
    return { reminded };
  }

  // --- helpers ----------------------------------------------------------------

  /** What the service team gets for a round, read live. */
  private async packageOf(projectId: string, round: RoundRow) {
    const label = `A-${round.seq}`;
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: {
        contract: {
          select: {
            id: true,
            contractNo: true,
            customerId: true,
            terms: {
              select: {
                warrantyMonths: true,
                warrantyScope: true,
                serviceLevels: true,
                serviceCoverage: true,
                serviceReportEvery: true,
              },
            },
          },
        },
      },
    });
    const contract = project?.contract;
    const [warranties, documents, certificate, contacts, openPoints] =
      await Promise.all([
        this.prisma.serviceEntitlement.findMany({
          where: {
            projectId,
            kind: 'warranty',
            source: label,
            cancelledAt: null,
          },
          select: {
            id: true,
            title: true,
            startOn: true,
            endOn: true,
            assets: {
              where: { removedAt: null },
              select: {
                asset: {
                  select: {
                    id: true,
                    name: true,
                    model: true,
                    serialNo: true,
                    location: true,
                  },
                },
              },
            },
          },
        }),
        round.milestoneId
          ? this.prisma.projectDeliveryDocument.findMany({
              where: {
                projectId,
                milestoneId: round.milestoneId,
                deletedAt: null,
              },
              select: { id: true, title: true, fileName: true },
            })
          : Promise.resolve([]),
        this.prisma.acceptanceCertificate.findUnique({
          where: { acceptanceId: round.id },
          select: { id: true, certificateNo: true, status: true, source: true },
        }),
        contract?.customerId
          ? this.prisma.customerContact.findMany({
              where: { customerId: contract.customerId, active: true },
              select: {
                id: true,
                name: true,
                role: true,
                position: true,
                phone: true,
                email: true,
                isPrimary: true,
              },
              orderBy: [{ isPrimary: 'desc' }, { name: 'asc' }],
            })
          : Promise.resolve([]),
        this.prisma.projectAcceptanceItem.findMany({
          where: { acceptanceId: round.id, status: 'open' },
          select: { text: true, dueOn: true },
        }),
      ]);
    const assets = warranties.flatMap((w) => w.assets.map((a) => a.asset));
    return {
      contractNo: contract?.contractNo ?? null,
      assets: [...new Map(assets.map((a) => [a.id, a])).values()],
      warranties: warranties.map((w) => ({
        id: w.id,
        title: w.title,
        startOn: day(w.startOn),
        endOn: day(w.endOn),
      })),
      serviceTerms: contract?.terms
        ? {
            warrantyMonths: contract.terms.warrantyMonths,
            warrantyScope: contract.terms.warrantyScope,
            serviceLevels: contract.terms.serviceLevels,
            coverage: contract.terms.serviceCoverage,
            reportEvery: contract.terms.serviceReportEvery,
          }
        : null,
      documents,
      certificate:
        certificate && certificate.status === 'signed' ? certificate : null,
      contacts,
      openPoints: openPoints.map((p) => ({
        text: p.text,
        dueOn: day(p.dueOn),
      })),
    };
  }

  private acceptedRounds(projectId: string) {
    return this.prisma.projectAcceptance.findMany({
      where: { projectId, status: { in: ['accepted', 'conditional'] } },
      select: {
        id: true,
        seq: true,
        milestoneId: true,
        status: true,
        decidedOn: true,
      },
      orderBy: { seq: 'asc' },
    }) as Promise<RoundRow[]>;
  }

  private async serviceTeam(companyId: string) {
    const rows = await this.prisma.userRole.findMany({
      where: {
        companyId,
        role: {
          active: true,
          permissions: { some: { permissionCode: 'service.asset.manage' } },
        },
      },
      select: { userId: true },
    });
    return [...new Set(rows.map((r) => r.userId))];
  }

  private assertReader(actor: Principal) {
    if (
      ![
        'service.asset.read',
        'service.asset.manage',
        'delivery.read',
        'delivery.manage',
      ].some((p) => hasPermission(actor, p as never))
    ) {
      throw new AppError('FORBIDDEN', 'ไม่มีสิทธิ์ดูรายการส่งมอบให้ทีมบริการ');
    }
  }

  private async forServiceTeam(actor: Principal, id: string) {
    if (!hasPermission(actor, 'service.asset.manage')) {
      throw new AppError('FORBIDDEN', 'รับทราบได้เฉพาะทีมบริการ');
    }
    const row = (await this.prisma.serviceHandover.findFirst({
      where: { id, companyId: actor.activeCompanyId },
    })) as HandoverRow | null;
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบรายการส่งมอบที่ระบุ');
    return row;
  }

  /** Tell whoever sent it what the service team said. */
  private async tell(
    row: HandoverRow,
    actor: Principal,
    outcome: 'acknowledged' | 'questioned',
    text: string,
  ) {
    await this.audit.record({
      eventType: `delivery.handover.${outcome}`,
      companyId: row.companyId,
      ...auditActor(actor),
      resourceType: 'project',
      resourceId: row.projectId,
      after: { handoverId: row.id, text },
    });
    if (row.sentBy === actor.userId) return;
    const project = await this.prisma.project.findUnique({
      where: { id: row.projectId },
      select: { projectNo: true, name: true },
    });
    const round = await this.prisma.projectAcceptance.findUnique({
      where: { id: row.acceptanceId },
      select: { seq: true },
    });
    await this.notifications.serviceHandover(
      row.sentBy,
      row.companyId,
      { id: row.projectId, label: `${project?.projectNo} · ${project?.name}` },
      `A-${round?.seq ?? '?'}`,
      outcome,
      text,
    );
  }

  private async names(rows: HandoverRow[]) {
    const ids = [
      ...new Set(
        rows
          .flatMap((r) => [r.sentBy, r.acknowledgedBy, r.questionedBy])
          .filter((id): id is string => !!id),
      ),
    ];
    const users = await this.prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, displayName: true },
    });
    return new Map(users.map((u) => [u.id, u.displayName]));
  }

  private handoverView(row: HandoverRow | null, names: Map<string, string>) {
    if (!row) return null;
    return {
      id: row.id,
      status: row.status,
      note: row.note,
      sentBy: names.get(row.sentBy) ?? row.sentBy,
      sentAt: row.sentAt,
      question: row.question,
      questionedBy: row.questionedBy
        ? (names.get(row.questionedBy) ?? row.questionedBy)
        : null,
      questionedAt: row.questionedAt,
      acknowledgedBy: row.acknowledgedBy
        ? (names.get(row.acknowledgedBy) ?? row.acknowledgedBy)
        : null,
      acknowledgedAt: row.acknowledgedAt,
      ackNote: row.ackNote,
    };
  }
}
