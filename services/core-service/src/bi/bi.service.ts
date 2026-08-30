import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AppError,
  auditActor,
  AuditWriter,
  PrismaTransactionService,
  resolveTargetCompany,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import type { BiDashboard, OrgUnit } from '@prisma/client';
import { embedDashboardUrl } from './metabase-embed';
import {
  BiDashboardRepository,
  BiDashboardWithAudience,
} from './bi-dashboard.repository';
import { CreateBiDashboardDto, UpdateBiDashboardDto } from './dto/bi.dto';

export interface BiMenuItem {
  key: string;
  title: string;
  embed_url: string;
}

export interface BiMenuResponse {
  configured: boolean;
  dashboards: BiMenuItem[];
  settings_url: string | null;
}

/** The admin representation of one dashboard row. */
export interface BiDashboardAdminItem {
  id: string;
  title: string;
  metabase_dashboard_id: number;
  sort_order: number;
  active: boolean;
  /** Empty = the whole company sees it. */
  org_units: { id: string; name: string; kind: string }[];
  updated_at: string;
}

/**
 * CD-92 v2 — dashboards as configuration, not env constants.
 *
 * The menu reads `bi_dashboards` for the caller's company and keeps only the
 * rows the caller's org unit may see; the admin surface under
 * `admin.bi.manage` edits those rows. The three `METABASE_DASHBOARD_*` env
 * ids remain as a fallback for a company that has configured nothing yet, so
 * an existing deployment keeps its menu until an admin takes over.
 */
@Injectable()
export class BiService {
  constructor(
    private readonly config: ConfigService,
    private readonly dashboards: BiDashboardRepository,
    private readonly tx: PrismaTransactionService,
    private readonly audit: AuditWriter,
  ) {}

  private get siteUrl(): string {
    return this.config.get<string>('metabase.siteUrl') ?? '';
  }

  private get embedSecret(): string {
    return this.config.get<string>('metabase.embedSecret') ?? '';
  }

  async menu(principal: Principal): Promise<BiMenuResponse> {
    const siteUrl = this.siteUrl;
    const secret = this.embedSecret;
    const configured = Boolean(siteUrl && secret);
    const companyId = principal.activeCompanyId;

    let items: { key: string; title: string; dashboardId: number }[] = [];

    if (configured) {
      // Inactive rows count too: a company whose admin retired every
      // dashboard chose an empty menu — falling back to env would undo that.
      const anyConfigured = await this.dashboards.count({
        where: { companyId },
      });

      items =
        anyConfigured > 0
          ? (
              await this.dashboards.findVisible(companyId, principal.orgUnitId)
            ).map((row) => ({
              key: row.id,
              title: row.title,
              dashboardId: row.metabaseDashboardId,
            }))
          : this.envFallback();
    }

    return {
      configured,
      dashboards: items.map((item) => ({
        key: item.key,
        title: item.title,
        embed_url: embedDashboardUrl(siteUrl, secret, item.dashboardId),
      })),
      // หน้า setting ของ Metabase — โผล่ในเมนูเฉพาะแอดมิน BI
      settings_url: principal.permissions.includes('admin.bi.manage')
        ? siteUrl || null
        : null,
    };
  }

  /** The original CD-92 trio, kept until the company has rows of its own. */
  private envFallback(): { key: string; title: string; dashboardId: number }[] {
    const ids = {
      requestOverview:
        this.config.get<number>('metabase.dashboards.requestOverview') ?? 0,
      approval: this.config.get<number>('metabase.dashboards.approval') ?? 0,
      sla: this.config.get<number>('metabase.dashboards.sla') ?? 0,
    };
    const titles: Record<keyof typeof ids, string> = {
      requestOverview: 'ภาพรวมคำขอ',
      approval: 'การอนุมัติ',
      sla: 'SLA',
    };

    return (Object.keys(ids) as (keyof typeof ids)[])
      .filter((key) => ids[key] > 0)
      .map((key) => ({ key, title: titles[key], dashboardId: ids[key] }));
  }

  async listAdmin(
    actor: Principal,
    requestedCompanyId?: string,
  ): Promise<BiDashboardAdminItem[]> {
    const companyId = resolveTargetCompany(actor, requestedCompanyId);
    const rows = await this.dashboards.findForCompany(companyId);

    return rows.map((row) => this.toAdminItem(row));
  }

  listOrgUnits(
    actor: Principal,
    requestedCompanyId?: string,
  ): Promise<Pick<OrgUnit, 'id' | 'name' | 'kind' | 'parentId'>[]> {
    const companyId = resolveTargetCompany(actor, requestedCompanyId);

    return this.dashboards.findCompanyUnits(companyId);
  }

  async create(
    dto: CreateBiDashboardDto,
    actor: Principal,
  ): Promise<BiDashboardAdminItem> {
    const companyId = resolveTargetCompany(actor, dto.company_id);
    const orgUnitIds = [...new Set(dto.org_unit_ids ?? [])];
    const units = await this.requireAssignableUnits(orgUnitIds, companyId);

    const created = await this.tx.execute(async (prisma) => {
      const row = await this.dashboards.create(
        {
          data: {
            companyId,
            title: dto.title.trim(),
            metabaseDashboardId: dto.metabase_dashboard_id,
            sortOrder: dto.sort_order ?? 0,
            createdBy: actor.userId,
            audiences: {
              create: orgUnitIds.map((orgUnitId) => ({ orgUnitId })),
            },
          },
        },
        { prisma },
      );

      await this.audit.record(
        {
          eventType: 'bi.dashboard.created',
          companyId,
          ...auditActor(actor),
          resourceType: 'bi_dashboard',
          resourceId: row.id,
          after: {
            title: row.title,
            metabaseDashboardId: row.metabaseDashboardId,
            orgUnitIds,
          },
        },
        { prisma },
      );

      return row;
    });

    return this.toAdminItem({
      ...created,
      audiences: units.map((unit) => ({
        dashboardId: created.id,
        orgUnitId: unit.id,
        orgUnit: unit,
      })),
    });
  }

  async update(
    id: string,
    dto: UpdateBiDashboardDto,
    actor: Principal,
  ): Promise<BiDashboardAdminItem> {
    const existing = await this.requireOwn(id, actor);
    const companyId = existing.companyId;

    const orgUnitIds =
      dto.org_unit_ids === undefined
        ? undefined
        : [...new Set(dto.org_unit_ids)];
    const units =
      orgUnitIds === undefined
        ? existing.audiences.map((audience) => audience.orgUnit)
        : await this.requireAssignableUnits(orgUnitIds, companyId);

    const updated = await this.tx.execute(async (prisma) => {
      const row = await this.dashboards.update(
        {
          where: { id },
          data: {
            ...(dto.title !== undefined ? { title: dto.title.trim() } : {}),
            ...(dto.metabase_dashboard_id !== undefined
              ? { metabaseDashboardId: dto.metabase_dashboard_id }
              : {}),
            ...(dto.sort_order !== undefined
              ? { sortOrder: dto.sort_order }
              : {}),
            ...(dto.active !== undefined ? { active: dto.active } : {}),
            updatedBy: actor.userId,
          },
        },
        { prisma },
      );

      if (orgUnitIds !== undefined) {
        await this.dashboards.replaceAudiences(id, orgUnitIds, { prisma });
      }

      await this.audit.record(
        {
          eventType: 'bi.dashboard.updated',
          companyId,
          ...auditActor(actor),
          resourceType: 'bi_dashboard',
          resourceId: id,
          before: {
            title: existing.title,
            metabaseDashboardId: existing.metabaseDashboardId,
            sortOrder: existing.sortOrder,
            active: existing.active,
            orgUnitIds: existing.audiences.map(
              (audience) => audience.orgUnitId,
            ),
          },
          after: {
            title: row.title,
            metabaseDashboardId: row.metabaseDashboardId,
            sortOrder: row.sortOrder,
            active: row.active,
            orgUnitIds: units.map((unit) => unit.id),
          },
        },
        { prisma },
      );

      return row;
    });

    return this.toAdminItem({
      ...updated,
      audiences: units.map((unit) => ({
        dashboardId: id,
        orgUnitId: unit.id,
        orgUnit: unit,
      })),
    });
  }

  /** DELETE is a soft delete: the row stays, `active` goes false. */
  async deactivate(id: string, actor: Principal): Promise<void> {
    const existing = await this.requireOwn(id, actor);

    await this.tx.execute(async (prisma) => {
      await this.dashboards.update(
        {
          where: { id },
          data: { active: false, updatedBy: actor.userId },
        },
        { prisma },
      );

      await this.audit.record(
        {
          eventType: 'bi.dashboard.deactivated',
          companyId: existing.companyId,
          ...auditActor(actor),
          resourceType: 'bi_dashboard',
          resourceId: id,
          before: { title: existing.title, active: existing.active },
          after: { title: existing.title, active: false },
        },
        { prisma },
      );
    });
  }

  /** 404 for an id outside the caller's companies — never 403 (SCOPE-03). */
  private async requireOwn(
    id: string,
    actor: Principal,
  ): Promise<BiDashboardWithAudience> {
    const row = await this.dashboards.findOwn(
      id,
      actor.companies.map((company) => company.id),
    );

    if (!row) {
      throw new AppError('NOT_FOUND', 'ไม่พบแดชบอร์ดที่ระบุ');
    }

    return row;
  }

  /**
   * Every submitted audience unit must be an active unit of the target
   * company; anything else is rejected without confirming whether the id
   * exists elsewhere.
   */
  private async requireAssignableUnits(
    orgUnitIds: readonly string[],
    companyId: string,
  ): Promise<Pick<OrgUnit, 'id' | 'name' | 'kind'>[]> {
    const units = await this.dashboards.findAssignableUnits(
      orgUnitIds,
      companyId,
    );

    if (units.length !== orgUnitIds.length) {
      const found = new Set(units.map((unit) => unit.id));

      throw new AppError(
        'VALIDATION_FAILED',
        'มีหน่วยงานที่ไม่ถูกต้องหรือไม่อยู่ในบริษัทนี้',
        orgUnitIds
          .filter((unitId) => !found.has(unitId))
          .map((unitId) => ({ field: 'org_unit_ids', reason: unitId })),
      );
    }

    return units;
  }

  private toAdminItem(row: BiDashboardWithAudience): BiDashboardAdminItem {
    return {
      id: row.id,
      title: row.title,
      metabase_dashboard_id: row.metabaseDashboardId,
      sort_order: row.sortOrder,
      active: row.active,
      org_units: row.audiences.map((audience) => ({
        id: audience.orgUnit.id,
        name: audience.orgUnit.name,
        kind: audience.orgUnit.kind,
      })),
      updated_at: row.updatedAt.toISOString(),
    };
  }
}
