import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  AppError,
  AuditWriter,
  auditActor,
  Principal,
  PrismaTransactionService,
} from '@request-management/share';
import { CompanyMemberRepository } from '../access/company-member.repository';
import { CustomerRepository } from '../crm/customer.repository';
import { thaiToday } from '../crm/vendor-costs';
import {
  ProjectDeploymentRepository,
  ProjectEnvironmentRepository,
  ProjectInstallationRepository,
  ProjectRepository,
} from '../pm/project.repositories';
import { currentOf } from '../pm/release-rules';
import {
  assetProblems,
  assetsFromProject,
  MAX_ASSET_TEXT,
  serialKey,
} from './asset-rules';
import {
  AssetStatusDto,
  ImportAssetRowDto,
  ImportAssetsDto,
  ListAssetsQueryDto,
  SaveAssetDto,
} from './support.dto';
import { EntitlementsService } from './entitlements.service';
import {
  ServiceAssetHistoryRepository,
  ServiceAssetRepository,
} from './support.repositories';

interface AssetRow {
  id: string;
  companyId: string;
  customerId: string | null;
  projectId: string | null;
  kind: string;
  source: string;
  installationId: string | null;
  environmentId: string | null;
  productCode: string | null;
  name: string;
  model: string | null;
  serialNo: string | null;
  location: string | null;
  version: string | null;
  installedOn: Date | null;
  acceptedOn: Date | null;
  status: string;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const day = (value: Date | null) =>
  value ? value.toISOString().slice(0, 10) : null;
const date = (value: string) => new Date(`${value}T00:00:00Z`);
const LIMIT = 200;

/** The part of an asset a change compares and the history keeps. */
const snapshot = (row: Record<string, unknown>) => ({
  customerId: row.customerId ?? null,
  name: row.name ?? null,
  productCode: row.productCode ?? null,
  model: row.model ?? null,
  serialNo: row.serialNo ?? null,
  location: row.location ?? null,
  version: row.version ?? null,
  installedOn:
    row.installedOn instanceof Date
      ? day(row.installedOn)
      : (row.installedOn ?? null),
  note: row.note ?? null,
  status: row.status ?? null,
});

/**
 * CD-236 ทะเบียนอุปกรณ์ที่ติดตั้ง — what each customer has, where, which
 * serial, and which software version runs on their production now: made at
 * every accepted acceptance round (CD-189) from the project's installed
 * points (CD-216) and production environments (CD-214), so it exists from
 * the first delivered project; what predates the system the service team
 * adds by hand or from a file. Every change is kept with its reason.
 *
 * Who: `service.asset.read` reads; `service.asset.manage` adds, corrects,
 * changes status and imports. The acceptance itself writes as the system.
 */
@Injectable()
export class ServiceAssetsService {
  private readonly logger = new Logger(ServiceAssetsService.name);

  constructor(
    private readonly assets: ServiceAssetRepository,
    private readonly history: ServiceAssetHistoryRepository,
    private readonly projects: ProjectRepository,
    private readonly installations: ProjectInstallationRepository,
    private readonly environments: ProjectEnvironmentRepository,
    private readonly deployments: ProjectDeploymentRepository,
    private readonly customers: CustomerRepository,
    private readonly people: CompanyMemberRepository,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
    private readonly entitlements: EntitlementsService,
  ) {}

  /**
   * An acceptance round passed (accepted, or with conditions): every point
   * installed since and every production environment not yet registered
   * goes in, dated by the acceptance. Once each.
   */
  async registerFromAcceptance(input: {
    projectId: string;
    companyId: string;
    acceptedOn: string;
    actorId: string;
    label: string;
  }) {
    const project = (await this.projects.findFirst({
      where: { id: input.projectId, companyId: input.companyId },
      select: {
        id: true,
        name: true,
        customerId: true,
        contractId: true,
        baseline: true,
      },
    })) as {
      id: string;
      name: string;
      customerId: string | null;
      contractId: string;
      baseline: unknown;
    } | null;
    if (!project) return [];
    const [points, envs, registered] = await Promise.all([
      this.installations.findMany({
        where: { projectId: project.id, deletedAt: null },
        select: {
          id: true,
          seq: true,
          location: true,
          boqIndex: true,
          serialNo: true,
          installedOn: true,
        },
      }) as Promise<
        {
          id: string;
          seq: number;
          location: string;
          boqIndex: number | null;
          serialNo: string | null;
          installedOn: Date | null;
        }[]
      >,
      this.environments.findMany({
        where: { projectId: project.id, deletedAt: null },
        select: { id: true, kind: true, name: true },
      }) as Promise<{ id: string; kind: string; name: string }[]>,
      this.assets.findMany({
        where: { projectId: project.id },
        select: { installationId: true, environmentId: true },
      }) as Promise<
        { installationId: string | null; environmentId: string | null }[]
      >,
    ]);
    const drafts = assetsFromProject({
      projectName: project.name,
      baseline: project.baseline,
      points: points.map((point) => ({
        ...point,
        installedOn: day(point.installedOn),
      })),
      environments: envs,
      registered: {
        installationIds: new Set(
          registered.flatMap((row) => row.installationId ?? []),
        ),
        environmentIds: new Set(
          registered.flatMap((row) => row.environmentId ?? []),
        ),
      },
    });
    const created: string[] = [];
    for (const draft of drafts) {
      // a serial already in the register (moved, or entered by hand) is
      // left to the service team rather than duplicated
      const serial = serialKey(draft.serialNo);
      try {
        const id = await this.transactions.execute(async (prisma) => {
          const row = await prisma.serviceAsset.create({
            data: {
              companyId: input.companyId,
              customerId: project.customerId,
              projectId: project.id,
              kind: draft.kind,
              source: 'project',
              installationId: draft.installationId,
              environmentId: draft.environmentId,
              productCode: draft.productCode,
              name: draft.name.slice(0, MAX_ASSET_TEXT),
              model: draft.model,
              serialNo: serial,
              location: draft.location,
              installedOn: draft.installedOn ? date(draft.installedOn) : null,
              acceptedOn: date(input.acceptedOn),
              createdBy: input.actorId,
            },
            select: { id: true },
          });
          await prisma.serviceAssetHistory.create({
            data: {
              companyId: input.companyId,
              assetId: row.id,
              action: 'created',
              after: {
                ...snapshot({ ...draft, serialNo: serial }),
                from: input.label,
              },
              reason: `ตรวจรับ ${input.label}`,
              actorId: input.actorId,
            },
          });
          return row.id;
        });
        created.push(id);
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ) {
          this.logger.warn(
            `asset not registered (already there): ${draft.serialNo ?? draft.environmentId}`,
          );
          continue;
        }
        throw error;
      }
    }
    // CD-237 — the contract's warranty over what this round delivered
    if (created.length) {
      await this.entitlements.warrantyFromAcceptance({
        companyId: input.companyId,
        projectId: project.id,
        customerId: project.customerId,
        contractId: project.contractId,
        acceptedOn: input.acceptedOn,
        label: input.label,
        assetIds: created,
        actorId: input.actorId,
      });
    }
    if (created.length) {
      await this.audit.record({
        eventType: 'service.asset.registered',
        companyId: input.companyId,
        actorId: null,
        actorUsername: 'system',
        resourceType: 'project',
        resourceId: project.id,
        after: { acceptance: input.label, assets: created.length },
      });
    }
    return created;
  }

  async list(actor: Principal, query: ListAssetsQueryDto) {
    const companyId = actor.activeCompanyId;
    const q = query.q?.trim();
    const like = q ? { contains: q, mode: 'insensitive' as const } : null;
    const status =
      query.status === 'all' ? undefined : (query.status ?? 'active');
    const where: Prisma.ServiceAssetWhereInput = {
      companyId,
      ...(status ? { status } : {}),
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.customer_id ? { customerId: query.customer_id } : {}),
      ...(like
        ? {
            OR: [
              {
                serialNo: { contains: serialKey(q) ?? q, mode: 'insensitive' },
              },
              { name: like },
              { model: like },
              { location: like },
              { productCode: like },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.assets.findMany({
        where,
        orderBy: [{ customerId: 'asc' }, { name: 'asc' }],
        take: LIMIT,
      }) as Promise<AssetRow[]>,
      this.assets.count({ where }),
    ]);
    const views = await this.views(rows);
    const covered = await this.entitlements.forAssets(
      companyId,
      rows.map((row) => row.id),
    );
    return {
      total,
      limited: total > LIMIT,
      items: views.map((row) => {
        const current = covered.get(row.id)?.current ?? null;
        return {
          ...row,
          coverage: current
            ? {
                kind: current.kind,
                title: current.title,
                endOn: current.endOn,
                coverage: current.coverage,
              }
            : null,
        };
      }),
    };
  }

  async detail(actor: Principal, id: string) {
    const row = await this.requireAsset(actor.activeCompanyId, id);
    const [view] = await this.views([row]);
    const history = (await this.history.findMany({
      where: { assetId: id },
      orderBy: { at: 'desc' },
    })) as {
      id: string;
      action: string;
      before: unknown;
      after: unknown;
      reason: string | null;
      actorId: string;
      at: Date;
    }[];
    const names = await this.displayNames(history.map((row) => row.actorId));
    const covered = (
      await this.entitlements.forAssets(actor.activeCompanyId, [id])
    ).get(id);
    return {
      ...view,
      coverage: covered?.current ?? null,
      entitlements: covered?.all ?? [],
      history: history.map((entry) => ({
        ...entry,
        actorName: names.get(entry.actorId) ?? null,
      })),
    };
  }

  async create(actor: Principal, dto: SaveAssetDto) {
    const companyId = actor.activeCompanyId;
    const input = await this.input(companyId, dto, null);
    const row = await this.write(async (prisma) => {
      const created = await prisma.serviceAsset.create({
        data: {
          companyId,
          ...input,
          source: 'manual',
          createdBy: actor.userId,
        },
      });
      await prisma.serviceAssetHistory.create({
        data: {
          companyId,
          assetId: created.id,
          action: 'created',
          after: snapshot(input as never),
          reason: dto.reason?.trim() || null,
          actorId: actor.userId,
        },
      });
      return created;
    });
    return this.detail(actor, row.id);
  }

  async update(actor: Principal, id: string, dto: SaveAssetDto) {
    const companyId = actor.activeCompanyId;
    const current = await this.requireAsset(companyId, id);
    const reason = dto.reason?.trim() ?? '';
    if (!reason) {
      throw new AppError('VALIDATION_FAILED', 'ต้องระบุเหตุผลที่แก้', [
        { field: 'reason', reason: 'required' },
      ]);
    }
    const input = await this.input(companyId, dto, current);
    await this.write(async (prisma) => {
      await prisma.serviceAsset.update({
        where: { id },
        data: { ...input, updatedBy: actor.userId },
      });
      await prisma.serviceAssetHistory.create({
        data: {
          companyId,
          assetId: id,
          action: 'updated',
          before: snapshot(current as never),
          after: snapshot(input as never),
          reason,
          actorId: actor.userId,
        },
      });
    });
    return this.detail(actor, id);
  }

  async setStatus(actor: Principal, id: string, dto: AssetStatusDto) {
    const companyId = actor.activeCompanyId;
    const current = await this.requireAsset(companyId, id);
    if (current.status === dto.status) {
      throw new AppError('CONFLICT', 'สถานะนี้อยู่แล้ว');
    }
    await this.write(async (prisma) => {
      await prisma.serviceAsset.update({
        where: { id },
        data: { status: dto.status, updatedBy: actor.userId },
      });
      await prisma.serviceAssetHistory.create({
        data: {
          companyId,
          assetId: id,
          action: 'status',
          before: { status: current.status },
          after: { status: dto.status },
          reason: dto.reason.trim(),
          actorId: actor.userId,
        },
      });
    });
    return this.detail(actor, id);
  }

  /**
   * The base that predates the system: every row checked (customer code,
   * fields, a serial already in the register or twice in the file); the dry
   * run reports, the commit writes each good row on its own.
   */
  async import(actor: Principal, dto: ImportAssetsDto) {
    const companyId = actor.activeCompanyId;
    const today = thaiToday();
    const codes = [
      ...new Set(
        dto.rows
          .map((row) => row.customer_code?.trim())
          .filter((code): code is string => Boolean(code)),
      ),
    ];
    const customers = new Map(
      (
        (await this.customers.findMany({
          where: { companyId, customerCode: { in: codes } },
          select: { id: true, customerCode: true },
        })) as { id: string; customerCode: string }[]
      ).map((row) => [row.customerCode, row.id]),
    );
    const serials = dto.rows
      .map((row) => serialKey(row.serial_no))
      .filter((key): key is string => Boolean(key));
    const taken = new Set(
      (
        (await this.assets.findMany({
          where: { companyId, serialNo: { in: serials } },
          select: { serialNo: true },
        })) as { serialNo: string | null }[]
      ).map((row) => row.serialNo),
    );
    const inFile = new Set<string>();
    const results: {
      rowNo: number;
      action: 'create' | 'skip_duplicate' | 'error';
      reasons: string[];
      assetId?: string;
    }[] = [];
    for (const row of dto.rows) {
      const reasons = this.rowProblems(row, today, customers);
      const serial = serialKey(row.serial_no);
      if (serial && (taken.has(serial) || inFile.has(serial))) {
        results.push({
          rowNo: row.row_no,
          action: 'skip_duplicate',
          reasons: [`หมายเลขเครื่อง ${serial} มีในทะเบียนแล้ว`],
        });
        continue;
      }
      if (reasons.length) {
        results.push({ rowNo: row.row_no, action: 'error', reasons });
        continue;
      }
      if (serial) inFile.add(serial);
      if (dto.mode === 'dry_run') {
        results.push({ rowNo: row.row_no, action: 'create', reasons: [] });
        continue;
      }
      try {
        const data = this.rowData(row, customers);
        const created = await this.transactions.execute(async (prisma) => {
          const asset = await prisma.serviceAsset.create({
            data: {
              companyId,
              ...data,
              source: 'import',
              createdBy: actor.userId,
            },
            select: { id: true },
          });
          await prisma.serviceAssetHistory.create({
            data: {
              companyId,
              assetId: asset.id,
              action: 'created',
              after: { ...snapshot(data as never), importId: dto.import_id },
              reason: `นำเข้าจากไฟล์ แถว ${row.row_no}`,
              actorId: actor.userId,
            },
          });
          return asset.id;
        });
        results.push({
          rowNo: row.row_no,
          action: 'create',
          reasons: [],
          assetId: created,
        });
      } catch (error) {
        results.push({
          rowNo: row.row_no,
          action: 'error',
          reasons: [error instanceof Error ? error.message : String(error)],
        });
      }
    }
    const summary = {
      create: results.filter((r) => r.action === 'create').length,
      skip: results.filter((r) => r.action === 'skip_duplicate').length,
      error: results.filter((r) => r.action === 'error').length,
    };
    if (dto.mode === 'commit') {
      await this.audit.record({
        eventType: 'service.asset.import_batch',
        companyId,
        ...auditActor(actor),
        resourceType: 'service_asset_import',
        resourceId: dto.import_id,
        after: { rows: dto.rows.length, ...summary },
      });
    }
    return { importId: dto.import_id, mode: dto.mode, summary, results };
  }

  // --- helpers -----------------------------------------------------------------------

  /** Rows as shown: customer, project, and software's version on production now. */
  private async views(rows: AssetRow[]) {
    const customerIds = [
      ...new Set(rows.flatMap((row) => row.customerId ?? [])),
    ];
    const projectIds = [...new Set(rows.flatMap((row) => row.projectId ?? []))];
    const envIds = rows.flatMap((row) => row.environmentId ?? []);
    const [customers, projects, deployed] = await Promise.all([
      customerIds.length
        ? (this.customers.findMany({
            where: { id: { in: customerIds } },
            select: { id: true, customerCode: true, nameTh: true },
          }) as Promise<{ id: string; customerCode: string; nameTh: string }[]>)
        : Promise.resolve([]),
      projectIds.length
        ? (this.projects.findMany({
            where: { id: { in: projectIds } },
            select: { id: true, projectNo: true, name: true },
          }) as Promise<{ id: string; projectNo: string; name: string }[]>)
        : Promise.resolve([]),
      envIds.length
        ? (this.deployments.findMany({
            where: { environmentId: { in: envIds } },
            select: {
              environmentId: true,
              deployedAt: true,
              release: { select: { version: true } },
            },
          }) as unknown as Promise<
            {
              environmentId: string;
              deployedAt: Date;
              release: { version: string };
            }[]
          >)
        : Promise.resolve([]),
    ]);
    const customer = new Map(customers.map((row) => [row.id, row]));
    const project = new Map(projects.map((row) => [row.id, row]));
    const running = currentOf(deployed);
    return rows.map((row) => {
      const live = row.environmentId ? running.get(row.environmentId) : null;
      const owner = row.customerId ? customer.get(row.customerId) : undefined;
      const from = row.projectId ? project.get(row.projectId) : undefined;
      return {
        id: row.id,
        kind: row.kind,
        source: row.source,
        customer: owner
          ? { id: owner.id, code: owner.customerCode, name: owner.nameTh }
          : null,
        project: from
          ? { id: from.id, label: `${from.projectNo} · ${from.name}` }
          : null,
        productCode: row.productCode,
        name: row.name,
        model: row.model,
        serialNo: row.serialNo,
        location: row.location,
        // software from a project: what runs on its production now
        version: live?.release.version ?? row.version,
        versionDeployedAt: live?.deployedAt ?? null,
        installedOn: day(row.installedOn),
        acceptedOn: day(row.acceptedOn),
        status: row.status,
        note: row.note,
        updatedAt: row.updatedAt,
      };
    });
  }

  private async input(
    companyId: string,
    dto: SaveAssetDto,
    current: AssetRow | null,
  ) {
    const text = (given: string | undefined, was: string | null | undefined) =>
      given === undefined ? (was ?? null) : given.trim() || null;
    const kind = dto.kind ?? current?.kind ?? '';
    const name = (dto.name ?? current?.name ?? '').trim();
    const serialNo =
      dto.serial_no === undefined
        ? (current?.serialNo ?? null)
        : serialKey(dto.serial_no);
    const installedOn =
      dto.installed_on === undefined
        ? day(current?.installedOn ?? null)
        : dto.installed_on.trim() || null;
    const problems = assetProblems({
      kind,
      name,
      serialNo: serialNo ?? '',
      installedOn: installedOn ?? '',
      today: thaiToday(),
    });
    // a project's asset keeps its kind and origin
    if (current && current.source === 'project' && kind !== current.kind) {
      problems.push('อุปกรณ์จากโครงการเปลี่ยนชนิดไม่ได้');
    }
    const customerId =
      dto.customer_id === undefined
        ? (current?.customerId ?? null)
        : dto.customer_id || null;
    if (customerId) {
      const found = await this.customers.count({
        where: { id: customerId, companyId },
      });
      if (!found) problems.push('ไม่พบลูกค้านี้');
    } else if (!current?.projectId) {
      problems.push('ต้องระบุลูกค้า');
    }
    if (serialNo) {
      const clash = await this.assets.count({
        where: {
          companyId,
          serialNo,
          ...(current ? { id: { not: current.id } } : {}),
        },
      });
      if (clash) problems.push(`หมายเลขเครื่อง ${serialNo} มีในทะเบียนแล้ว`);
    }
    if (problems.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        problems[0],
        problems.map((reason) => ({ field: 'asset', reason })),
      );
    }
    return {
      kind,
      customerId,
      name: name.slice(0, MAX_ASSET_TEXT),
      productCode: text(dto.product_code, current?.productCode),
      model: text(dto.model, current?.model),
      serialNo,
      location: text(dto.location, current?.location),
      version: text(dto.version, current?.version),
      installedOn: installedOn ? date(installedOn) : null,
      note: text(dto.note, current?.note),
    };
  }

  private rowProblems(
    row: ImportAssetRowDto,
    today: string,
    customers: Map<string, string>,
  ) {
    const problems = assetProblems({
      kind: (row.kind ?? 'equipment').trim() || 'equipment',
      name: row.name ?? '',
      serialNo: row.serial_no ?? '',
      installedOn: row.installed_on?.trim() ?? '',
      today,
    });
    const code = row.customer_code?.trim();
    if (!code) problems.push('ต้องระบุรหัสลูกค้า');
    else if (!customers.has(code)) problems.push(`ไม่พบลูกค้ารหัส ${code}`);
    return problems;
  }

  private rowData(row: ImportAssetRowDto, customers: Map<string, string>) {
    const text = (value: string | undefined) => value?.trim() || null;
    const installedOn = text(row.installed_on);
    return {
      kind: (row.kind ?? 'equipment').trim() || 'equipment',
      customerId: customers.get(row.customer_code!.trim())!,
      name: row.name!.trim().slice(0, MAX_ASSET_TEXT),
      productCode: text(row.product_code),
      model: text(row.model),
      serialNo: serialKey(row.serial_no),
      location: text(row.location),
      version: text(row.version),
      installedOn: installedOn ? date(installedOn) : null,
      note: text(row.note),
    };
  }

  /** A write, with a serial taken meanwhile answered as a conflict. */
  private async write<T>(
    work: (prisma: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.transactions.execute((prisma) => work(prisma));
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new AppError('CONFLICT', 'หมายเลขเครื่องนี้มีในทะเบียนแล้ว');
      }
      throw error;
    }
  }

  private async requireAsset(companyId: string, id: string) {
    const row = (await this.assets.findFirst({
      where: { id, companyId },
    })) as AssetRow | null;
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบอุปกรณ์ที่ระบุ');
    return row;
  }

  private async displayNames(ids: (string | null)[]) {
    const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
    if (!unique.length) return new Map<string, string>();
    const users = (await this.people.findMany({
      where: { id: { in: unique } },
      select: { id: true, displayName: true },
    })) as { id: string; displayName: string }[];
    return new Map(users.map((user) => [user.id, user.displayName]));
  }
}
