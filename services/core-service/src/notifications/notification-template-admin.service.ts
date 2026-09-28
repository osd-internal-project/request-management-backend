import { Injectable } from '@nestjs/common';
import {
  AppError,
  auditActor,
  AuditWriter,
  PrismaTransactionService,
  resolveTargetCompany,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import {
  NOTIFICATION_TEMPLATES,
  templateOf,
  templateProblems,
  type TemplateDefinition,
} from './notification-templates';

export interface NotificationTemplateView {
  event_type: string;
  label: string;
  variables: { name: string; label: string; sample: string }[];
  standard: { title: string; body: string };
  /** The company's own wording; null = the standard is in use. */
  custom: { title: string; body: string; updated_at: string } | null;
}

/**
 * CD-54 — the admin side of message templates, per company. Configuration,
 * not transactional data: "reset to standard" removes the company's row, and
 * both that and every edit are audited with the text before and after.
 */
@Injectable()
export class NotificationTemplateAdminService {
  constructor(
    private readonly tx: PrismaTransactionService,
    private readonly audit: AuditWriter,
  ) {}

  async list(
    actor: Principal,
    companyId?: string,
  ): Promise<NotificationTemplateView[]> {
    const target = resolveTargetCompany(actor, companyId);
    const rows = await this.tx.execute((prisma) =>
      prisma.notificationTemplate.findMany({ where: { companyId: target } }),
    );
    const own = new Map(rows.map((row) => [row.eventType, row]));
    return NOTIFICATION_TEMPLATES.map((definition) => {
      const row = own.get(definition.eventType);
      return viewOf(
        definition,
        row
          ? {
              title: row.title,
              body: row.body,
              updated_at: row.updatedAt.toISOString(),
            }
          : null,
      );
    });
  }

  async save(
    eventType: string,
    dto: { title: string; body: string; company_id?: string },
    actor: Principal,
  ): Promise<NotificationTemplateView> {
    const definition = this.definitionOf(eventType);
    const companyId = resolveTargetCompany(actor, dto.company_id);
    const problems = templateProblems(definition, dto.title, dto.body);
    if (problems.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        problems[0],
        problems.map((reason) => ({ field: 'template', reason })),
      );
    }

    return this.tx.execute(async (prisma) => {
      const key = { companyId_eventType: { companyId, eventType } };
      const before = await prisma.notificationTemplate.findUnique({
        where: key,
      });
      const row = await prisma.notificationTemplate.upsert({
        where: key,
        create: {
          companyId,
          eventType,
          title: dto.title,
          body: dto.body,
          updatedBy: actor.userId,
        },
        update: { title: dto.title, body: dto.body, updatedBy: actor.userId },
      });
      await this.audit.record(
        {
          eventType: 'notification.template.updated',
          companyId,
          ...auditActor(actor),
          resourceType: 'notification_template',
          resourceId: eventType,
          before: before
            ? { title: before.title, body: before.body }
            : { standard: true },
          after: { title: row.title, body: row.body },
        },
        { prisma },
      );
      return viewOf(definition, {
        title: row.title,
        body: row.body,
        updated_at: row.updatedAt.toISOString(),
      });
    });
  }

  /** Back to the standard wording. Nothing to reset is not an error. */
  async reset(
    eventType: string,
    actor: Principal,
    companyId?: string,
  ): Promise<NotificationTemplateView> {
    const definition = this.definitionOf(eventType);
    const target = resolveTargetCompany(actor, companyId);

    return this.tx.execute(async (prisma) => {
      const key = { companyId_eventType: { companyId: target, eventType } };
      const before = await prisma.notificationTemplate.findUnique({
        where: key,
      });
      if (before) {
        await prisma.notificationTemplate.delete({ where: key });
        await this.audit.record(
          {
            eventType: 'notification.template.reset',
            companyId: target,
            ...auditActor(actor),
            resourceType: 'notification_template',
            resourceId: eventType,
            before: { title: before.title, body: before.body },
            after: { standard: true },
          },
          { prisma },
        );
      }
      return viewOf(definition, null);
    });
  }

  private definitionOf(eventType: string): TemplateDefinition {
    const definition = templateOf(eventType);
    if (!definition) {
      throw new AppError('NOT_FOUND', 'ไม่พบเหตุการณ์แจ้งเตือนที่ระบุ', [
        { field: 'event_type', reason: eventType },
      ]);
    }
    return definition;
  }
}

function viewOf(
  definition: TemplateDefinition,
  custom: NotificationTemplateView['custom'],
): NotificationTemplateView {
  return {
    event_type: definition.eventType,
    label: definition.label,
    variables: Object.entries(definition.variables).map(([name, value]) => ({
      name,
      ...value,
    })),
    standard: { title: definition.title, body: definition.body },
    custom,
  };
}
