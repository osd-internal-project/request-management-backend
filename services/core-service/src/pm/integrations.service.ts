import { Injectable } from '@nestjs/common';
import {
  AppError,
  AuditWriter,
  auditActor,
  Principal,
  PrismaTransactionService,
} from '@request-management/share';
import { CompanyMemberRepository } from '../access/company-member.repository';
import { CustomerContactRepository } from '../crm/customer-child.repositories';
import { SaveIntegrationDto } from './dto/project.dto';
import {
  integrationProblems,
  integrationTestText,
  MAX_INTEGRATION_TEXT,
} from './integration-rules';
import {
  ProjectConfigItemRepository,
  ProjectIntegrationRepository,
  ProjectTestItemRepository,
} from './project.repositories';
import { ProjectsService } from './projects.service';
import { testState } from './test-rules';

interface IntegrationRow {
  id: string;
  seq: number;
  name: string;
  targetSystem: string;
  direction: string;
  protocol: string | null;
  endpoint: string | null;
  description: string | null;
  contactId: string | null;
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  testItemId: string | null;
  createdBy: string;
}

interface ContactRow {
  id: string;
  name: string;
  position: string | null;
  phone: string | null;
  email: string | null;
}

interface TestRow {
  id: string;
  seq: number;
  waivedAt: Date | null;
  runs: { result: string; testedAt: Date; note: string | null }[];
}

type Access = Awaited<ReturnType<ProjectsService['access']>>;

/**
 * CD-219 เชื่อมต่อระบบ — where the delivered system meets the customer's
 * other systems: what, which way, how, and who answers for it on the
 * customer's side. Each point's connection test is a test item (CD-221,
 * `integration:<id>`) made with it, so its result is recorded under the
 * test rules (evidence for a pass, an issue for a fail) and counts toward
 * acceptance; its addresses and secrets live in the configuration (CD-217)
 * under the point's name.
 *
 * Who: whoever sees the project reads it; the team records points while the
 * project runs; the recorder or the manager removes one.
 */
@Injectable()
export class IntegrationsService {
  constructor(
    private readonly projects: ProjectsService,
    private readonly integrations: ProjectIntegrationRepository,
    private readonly testItems: ProjectTestItemRepository,
    private readonly configItems: ProjectConfigItemRepository,
    private readonly contacts: CustomerContactRepository,
    private readonly people: CompanyMemberRepository,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
  ) {}

  async view(projectId: string, actor: Principal) {
    const access = await this.projects.access(projectId, actor);
    const [rows, contacts] = await Promise.all([
      this.rows(projectId),
      this.contactRows(access.project.customerId),
    ]);
    const [tests, configs] = await Promise.all([
      this.testRows(rows),
      this.configCounts(projectId, rows),
    ]);
    const contact = new Map(contacts.map((row) => [row.id, row]));
    const test = new Map(tests.map((row) => [row.id, row]));
    return {
      canWrite: this.mayWrite(access, actor),
      canEdit: access.canEdit,
      contacts: contacts.map((row) => ({
        id: row.id,
        label: [row.name, row.position].filter(Boolean).join(' · '),
      })),
      integrations: rows.map((row) => {
        const item = row.testItemId ? test.get(row.testItemId) : undefined;
        const crm = row.contactId ? contact.get(row.contactId) : undefined;
        const latest = item?.runs[0];
        return {
          id: row.id,
          label: `I-${row.seq}`,
          name: row.name,
          targetSystem: row.targetSystem,
          direction: row.direction,
          protocol: row.protocol,
          endpoint: row.endpoint,
          description: row.description,
          contactId: row.contactId,
          contact: {
            name: crm?.name ?? row.contactName,
            phone: crm?.phone ?? row.contactPhone,
            email: crm?.email ?? row.contactEmail,
            fromCrm: Boolean(crm),
          },
          contactName: row.contactName,
          contactPhone: row.contactPhone,
          contactEmail: row.contactEmail,
          test: item
            ? {
                label: `T-${item.seq}`,
                state: testState(item),
                testedAt: latest?.testedAt.toISOString() ?? null,
                note: latest?.note ?? null,
              }
            : null,
          configCount: configs.get(row.name.trim().toLowerCase()) ?? 0,
          mayRemove: access.canEdit || row.createdBy === actor.userId,
        };
      }),
    };
  }

  async add(projectId: string, dto: SaveIntegrationDto, actor: Principal) {
    const access = await this.writer(projectId, actor);
    const input = await this.input(access, dto, null);
    await this.transactions.execute(async (prisma) => {
      const [last, lastTest] = await Promise.all([
        prisma.projectIntegration.findFirst({
          where: { projectId },
          orderBy: { seq: 'desc' },
          select: { seq: true },
        }),
        prisma.projectTestItem.findFirst({
          where: { projectId },
          orderBy: { seq: 'desc' },
          select: { seq: true },
        }),
      ]);
      const seq = (last?.seq ?? 0) + 1;
      const row = await prisma.projectIntegration.create({
        data: {
          companyId: access.project.companyId,
          projectId,
          seq,
          ...input,
          createdBy: actor.userId,
        },
        select: { id: true },
      });
      // its connection test, in the test plan (CD-221)
      const test = await prisma.projectTestItem.create({
        data: {
          companyId: access.project.companyId,
          projectId,
          seq: (lastTest?.seq ?? 0) + 1,
          source: 'integration',
          sourceRef: `integration:${row.id}`,
          text: integrationTestText({ seq, ...input }),
          steps: input.endpoint
            ? `ปลายทาง: ${input.endpoint}${input.protocol ? ` (${input.protocol})` : ''}`
            : null,
          createdBy: actor.userId,
        },
        select: { id: true },
      });
      await prisma.projectIntegration.update({
        where: { id: row.id },
        data: { testItemId: test.id },
      });
      await this.audit.record(
        {
          eventType: 'pm.integration.added',
          companyId: access.project.companyId,
          ...auditActor(actor),
          resourceType: 'project',
          resourceId: projectId,
          after: {
            integrationId: row.id,
            label: `I-${seq}`,
            name: input.name,
            targetSystem: input.targetSystem,
            testItemId: test.id,
          },
        },
        { prisma },
      );
    });
    return this.view(projectId, actor);
  }

  async update(
    projectId: string,
    integrationId: string,
    dto: SaveIntegrationDto,
    actor: Principal,
  ) {
    const access = await this.writer(projectId, actor);
    const current = await this.requireRow(projectId, integrationId);
    const input = await this.input(access, dto, current);
    await this.transactions.execute(async (prisma) => {
      await prisma.projectIntegration.update({
        where: { id: integrationId },
        data: { ...input, updatedBy: actor.userId },
      });
      // the test keeps up with what it proves
      if (current.testItemId) {
        await prisma.projectTestItem.update({
          where: { id: current.testItemId },
          data: {
            text: integrationTestText({ seq: current.seq, ...input }),
            updatedBy: actor.userId,
          },
        });
      }
      await this.audit.record(
        {
          eventType: 'pm.integration.updated',
          companyId: access.project.companyId,
          ...auditActor(actor),
          resourceType: 'project',
          resourceId: projectId,
          before: { name: current.name, targetSystem: current.targetSystem },
          after: {
            integrationId,
            name: input.name,
            targetSystem: input.targetSystem,
          },
        },
        { prisma },
      );
    });
    return this.view(projectId, actor);
  }

  /** Off the list with its test; their history stays. */
  async remove(projectId: string, integrationId: string, actor: Principal) {
    const access = await this.writer(projectId, actor);
    const current = await this.requireRow(projectId, integrationId);
    if (!access.canEdit && current.createdBy !== actor.userId) {
      throw new AppError(
        'FORBIDDEN',
        'นำออกได้เฉพาะผู้บันทึก หรือผู้จัดการโครงการ',
      );
    }
    const now = new Date();
    await this.transactions.execute(async (prisma) => {
      await prisma.projectIntegration.update({
        where: { id: integrationId },
        data: { deletedAt: now, deletedBy: actor.userId },
      });
      if (current.testItemId) {
        await prisma.projectTestItem.update({
          where: { id: current.testItemId },
          data: { deletedAt: now, updatedBy: actor.userId },
        });
      }
      await this.audit.record(
        {
          eventType: 'pm.integration.removed',
          companyId: access.project.companyId,
          ...auditActor(actor),
          resourceType: 'project',
          resourceId: projectId,
          before: { integrationId, name: current.name },
        },
        { prisma },
      );
    });
    return this.view(projectId, actor);
  }

  // --- helpers -----------------------------------------------------------------------

  private async input(
    access: Access,
    dto: SaveIntegrationDto,
    current: IntegrationRow | null,
  ) {
    const text = (given: string | undefined, was: string | null | undefined) =>
      given === undefined
        ? (was ?? null)
        : given.trim().slice(0, MAX_INTEGRATION_TEXT) || null;
    const contactId =
      dto.contact_id === undefined
        ? (current?.contactId ?? null)
        : dto.contact_id || null;
    const input = {
      name: (dto.name ?? current?.name ?? '').trim(),
      targetSystem: (dto.target_system ?? current?.targetSystem ?? '').trim(),
      direction: dto.direction ?? current?.direction ?? 'both',
      protocol: text(dto.protocol, current?.protocol),
      endpoint: text(dto.endpoint, current?.endpoint),
      description: text(dto.description, current?.description),
      contactId,
      // a CRM contact speaks for itself; typed details only without one
      contactName: contactId
        ? null
        : text(dto.contact_name, current?.contactName),
      contactPhone: contactId
        ? null
        : text(dto.contact_phone, current?.contactPhone),
      contactEmail: contactId
        ? null
        : text(dto.contact_email, current?.contactEmail),
    };
    const problems = integrationProblems({
      name: input.name,
      targetSystem: input.targetSystem,
      direction: input.direction,
      contactId,
      contactName: input.contactName ?? '',
      contactEmail: input.contactEmail ?? '',
    });
    if (contactId) {
      const found = access.project.customerId
        ? await this.contacts.count({
            where: { id: contactId, customerId: access.project.customerId },
          })
        : 0;
      if (!found) problems.push('ผู้ติดต่อนี้ไม่ใช่ของลูกค้าโครงการนี้');
    }
    if (input.name) {
      const clash = await this.integrations.count({
        where: {
          projectId: access.project.id,
          deletedAt: null,
          name: { equals: input.name, mode: 'insensitive' },
          ...(current ? { id: { not: current.id } } : {}),
        },
      });
      if (clash) problems.push('มีจุดเชื่อมต่อชื่อนี้แล้ว');
    }
    if (problems.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        problems[0],
        problems.map((reason) => ({ field: 'integration', reason })),
      );
    }
    return input;
  }

  private async rows(projectId: string) {
    return (await this.integrations.findMany({
      where: { projectId, deletedAt: null },
      orderBy: { seq: 'asc' },
    })) as IntegrationRow[];
  }

  private async contactRows(customerId: string | null) {
    if (!customerId) return [];
    return (await this.contacts.findMany({
      where: { customerId, active: true },
      orderBy: [{ isPrimary: 'desc' }, { name: 'asc' }],
      select: {
        id: true,
        name: true,
        position: true,
        phone: true,
        email: true,
      },
    })) as ContactRow[];
  }

  private async testRows(rows: IntegrationRow[]) {
    const ids = rows
      .map((row) => row.testItemId)
      .filter((id): id is string => Boolean(id));
    if (!ids.length) return [];
    return (await this.testItems.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        seq: true,
        waivedAt: true,
        runs: {
          orderBy: { testedAt: 'desc' },
          select: { result: true, testedAt: true, note: true },
        },
      },
    })) as unknown as TestRow[];
  }

  /** CD-217 values kept under each point's name. */
  private async configCounts(projectId: string, rows: IntegrationRow[]) {
    if (!rows.length) return new Map<string, number>();
    const values = (await this.configItems.findMany({
      where: {
        projectId,
        deletedAt: null,
        OR: rows.map((row) => ({
          system: { equals: row.name, mode: 'insensitive' as const },
        })),
      },
      select: { system: true },
    })) as { system: string }[];
    const counts = new Map<string, number>();
    for (const value of values) {
      const key = value.system.trim().toLowerCase();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }

  private async requireRow(projectId: string, integrationId: string) {
    const row = (await this.integrations.findFirst({
      where: { id: integrationId, projectId, deletedAt: null },
    })) as IntegrationRow | null;
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบจุดเชื่อมต่อ');
    return row;
  }

  private async writer(projectId: string, actor: Principal) {
    const access = await this.projects.access(projectId, actor);
    if (!this.mayWrite(access, actor)) {
      throw new AppError(
        'FORBIDDEN',
        'บันทึกจุดเชื่อมต่อได้เฉพาะทีมโครงการ ขณะโครงการยังดำเนินอยู่',
      );
    }
    return access;
  }

  private mayWrite(access: Access, actor: Principal) {
    const running =
      access.project.status === 'active' || access.project.status === 'on_hold';
    return (
      running &&
      (access.canEdit ||
        access.project.members.some((member) => member.userId === actor.userId))
    );
  }
}
