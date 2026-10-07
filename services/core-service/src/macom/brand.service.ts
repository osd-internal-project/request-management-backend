import { Prisma } from '@prisma/client';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  AppError,
  AuditWriter,
  auditActor,
  hasPermission,
  PrismaTransactionService,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import { CompanyMemberRepository } from '../access/company-member.repository';
import { CrmConfigRepository } from '../crm/segment.repositories';
import { DomainEventsService } from '../events/domain-events.service';
import {
  DOMAIN_EVENTS,
  type DomainEventName,
  type RequestEventPayload,
} from '../events/event-catalog';
import { NotificationsService } from '../notifications/notifications.service';
import { RequestsService } from '../requests/requests.service';
import {
  ListBrandAssetsQueryDto,
  RetireBrandAssetDto,
  UpdateBrandAssetDto,
} from './macom.dto';
import {
  BrandAssetRepository,
  BrandAssetVersionRepository,
} from './macom.repositories';

type Outcome = 'approved' | 'rejected' | 'cancelled';

export interface AssetRow {
  id: string;
  companyId: string;
  category: string;
  name: string;
  description: string | null;
  tags: string[];
  currentVersionId: string | null;
  retiredAt: Date | null;
  retireReason: string | null;
  updatedAt: Date;
}

export interface VersionRow {
  id: string;
  companyId: string;
  assetId: string;
  versionNo: number;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  storageKey: string;
  note: string | null;
  status: string;
  approvalRequestId: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  uploadedBy: string | null;
  createdAt: Date;
}

const MANAGE = 'crm.campaign.manage';

/**
 * CD-273 — the brand library (user decisions 6 Oct 2026): logos, proposal
 * templates and decks every team takes from one place, so no old version is
 * in circulation.
 *
 * - every signed-in member of staff browses and downloads the **current**
 *   version only; MACOM (`crm.campaign.manage`) also sees the history and
 *   versions waiting for approval, and retires an asset;
 * - a version — the first one too — becomes current only when approved: the
 *   upload raises and submits a request of the type in CRM settings
 *   (`brandApprovalTypeCode`), as content approval does (CD-272). Approved →
 *   current, the old one stays as history; rejected or withdrawn → it never
 *   shows to staff.
 *
 * Matched by `BrandAssetVersion.approvalRequestId`, never by type code.
 */
@Injectable()
export class BrandService implements OnModuleInit {
  private readonly logger = new Logger(BrandService.name);

  constructor(
    private readonly assets: BrandAssetRepository,
    private readonly versions: BrandAssetVersionRepository,
    private readonly requests: RequestsService,
    private readonly configs: CrmConfigRepository,
    private readonly people: CompanyMemberRepository,
    private readonly events: DomainEventsService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
  ) {}

  onModuleInit(): void {
    const outcomes: [DomainEventName, Outcome][] = [
      [DOMAIN_EVENTS.requestApproved, 'approved'],
      [DOMAIN_EVENTS.requestRejected, 'rejected'],
      [DOMAIN_EVENTS.requestCancelled, 'cancelled'],
    ];
    for (const [name, outcome] of outcomes) {
      this.events.on(name, (event) =>
        this.onRequestOutcome(event.payload as RequestEventPayload, outcome),
      );
    }
  }

  async list(actor: Principal, query: ListBrandAssetsQueryDto) {
    const manager = hasPermission(actor, MANAGE);
    const q = query.q?.trim();
    const rows = (await this.assets.findMany({
      where: {
        companyId: actor.activeCompanyId,
        ...(query.category ? { category: query.category } : {}),
        ...(manager && query.include_retired === 'true'
          ? {}
          : { retiredAt: null }),
        // staff see what has an approved version; MACOM sees the rest too
        ...(manager ? {} : { currentVersionId: { not: null } }),
        ...(q
          ? {
              OR: [
                { name: { contains: q, mode: 'insensitive' as const } },
                { description: { contains: q, mode: 'insensitive' as const } },
                { tags: { has: q } },
              ],
            }
          : {}),
      },
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
      take: 500,
    })) as AssetRow[];
    const ids = rows.flatMap((row) =>
      row.currentVersionId ? [row.currentVersionId] : [],
    );
    const [current, pending] = await Promise.all([
      ids.length
        ? (this.versions.findMany({
            where: { id: { in: ids } },
          }) as Promise<VersionRow[]>)
        : Promise.resolve([] as VersionRow[]),
      manager && rows.length
        ? (this.versions.findMany({
            where: {
              assetId: { in: rows.map((row) => row.id) },
              status: 'pending',
            },
            select: { assetId: true },
          }) as Promise<{ assetId: string }[]>)
        : Promise.resolve([] as { assetId: string }[]),
    ]);
    const byId = new Map(current.map((row) => [row.id, row]));
    return rows.map((row) => ({
      ...this.assetView(row, byId.get(row.currentVersionId ?? '') ?? null),
      pending_versions: pending.filter((p) => p.assetId === row.id).length,
    }));
  }

  async one(actor: Principal, id: string) {
    const manager = hasPermission(actor, MANAGE);
    const row = await this.requireAsset(actor, id, manager);
    const versions = (await this.versions.findMany({
      where: { assetId: id },
      orderBy: { versionNo: 'desc' },
    })) as VersionRow[];
    const current = versions.find((v) => v.id === row.currentVersionId) ?? null;
    const names = manager
      ? await this.namesOf(versions.map((v) => v.uploadedBy))
      : new Map<string, string>();
    return {
      ...this.assetView(row, current),
      // the history and what waits are MACOM's
      versions: manager
        ? versions.map((v) => ({
            ...this.versionView(v),
            status: v.id === row.currentVersionId ? 'current' : v.status,
            note: v.note,
            decision_note: v.decisionNote,
            approval_request_id: v.approvalRequestId,
            uploaded_by: v.uploadedBy
              ? (names.get(v.uploadedBy) ?? v.uploadedBy)
              : null,
            uploaded_at: v.createdAt.toISOString(),
          }))
        : [],
    };
  }

  async update(actor: Principal, id: string, dto: UpdateBrandAssetDto) {
    const row = await this.requireAsset(actor, id, true);
    await this.assets.update({
      where: { id },
      data: {
        ...(dto.category !== undefined ? { category: dto.category } : {}),
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.description !== undefined
          ? { description: dto.description.trim() || null }
          : {}),
        ...(dto.tags !== undefined
          ? {
              tags: [...new Set(dto.tags.map((t) => t.trim()).filter(Boolean))],
            }
          : {}),
        updatedBy: actor.userId,
      },
    });
    await this.audit.record({
      eventType: 'macom.brand.updated',
      companyId: row.companyId,
      ...auditActor(actor),
      resourceType: 'brand_asset',
      resourceId: id,
      before: { name: row.name, category: row.category },
      after: dto as unknown as Prisma.InputJsonValue,
    });
    return this.one(actor, id);
  }

  async retire(actor: Principal, id: string, dto: RetireBrandAssetDto | null) {
    const row = await this.requireAsset(actor, id, true);
    await this.assets.update({
      where: { id },
      data: dto
        ? {
            retiredAt: new Date(),
            retiredBy: actor.userId,
            retireReason: dto.reason.trim(),
            updatedBy: actor.userId,
          }
        : {
            retiredAt: null,
            retiredBy: null,
            retireReason: null,
            updatedBy: actor.userId,
          },
    });
    await this.audit.record({
      eventType: dto ? 'macom.brand.retired' : 'macom.brand.restored',
      companyId: row.companyId,
      ...auditActor(actor),
      resourceType: 'brand_asset',
      resourceId: id,
      after: { reason: dto?.reason ?? null },
    });
    return this.one(actor, id);
  }

  /** The approval request type; a new version cannot be uploaded without it. */
  async approvalType(companyId: string): Promise<string> {
    const config = (await this.configs.findFirst({
      where: { companyId },
      select: { brandApprovalTypeCode: true },
    })) as { brandApprovalTypeCode: string | null } | null;
    if (!config?.brandApprovalTypeCode) {
      throw new AppError(
        'CONFLICT',
        'ยังไม่ได้ตั้งประเภทคำขอ "อนุมัติไฟล์คลังแบรนด์" ในตั้งค่า CRM',
      );
    }
    return config.brandApprovalTypeCode;
  }

  /**
   * Raise and submit the approval of a version just stored. One that cannot
   * be submitted is withdrawn and the version marked cancelled.
   */
  async requestApproval(
    actor: Principal,
    asset: { id: string; companyId: string; name: string; category: string },
    version: {
      id: string;
      versionNo: number;
      fileName: string;
      note: string | null;
    },
    typeCode: string,
  ) {
    const created = (await this.requests.create(
      {
        type_code: typeCode,
        form_data: {
          subject: `อนุมัติไฟล์แบรนด์: ${asset.name} ฉบับที่ ${version.versionNo}`,
          asset_name: asset.name,
          category: asset.category,
          version_no: String(version.versionNo),
          file_name: version.fileName,
          note: version.note ?? '',
          asset_id: asset.id,
        },
      },
      actor,
    )) as { id: string; requestNo: string | null };
    try {
      await this.requests.submit(created.id, actor, '');
    } catch (error) {
      await this.requests
        .cancel(
          created.id,
          {
            reason: `ส่งอนุมัติไม่สำเร็จ: ${error instanceof Error ? error.message : 'ไม่ทราบสาเหตุ'}`,
          },
          actor,
        )
        .catch(() => undefined);
      await this.versions.update({
        where: { id: version.id },
        data: { status: 'cancelled', decisionNote: 'ส่งอนุมัติไม่สำเร็จ' },
      });
      throw error;
    }
    await this.versions.update({
      where: { id: version.id },
      data: { approvalRequestId: created.id },
    });
    await this.audit.record({
      eventType: 'macom.brand.approval_requested',
      companyId: asset.companyId,
      ...auditActor(actor),
      resourceType: 'brand_asset',
      resourceId: asset.id,
      after: {
        versionNo: version.versionNo,
        requestId: created.id,
        requestNo: created.requestNo,
      },
    });
  }

  /** Take a waiting version back — cancels its request. */
  async withdraw(actor: Principal, versionId: string) {
    const version = (await this.versions.findFirst({
      where: { id: versionId, companyId: actor.activeCompanyId },
    })) as VersionRow | null;
    if (!version) throw new AppError('NOT_FOUND', 'ไม่พบฉบับนี้');
    if (version.status !== 'pending' || !version.approvalRequestId) {
      throw new AppError('CONFLICT', 'ฉบับนี้ไม่ได้รออนุมัติอยู่');
    }
    await this.requests.cancel(
      version.approvalRequestId,
      { reason: 'ถอนไฟล์ฉบับนี้ออก' },
      actor,
    );
    await this.onRequestOutcome(
      {
        request_id: version.approvalRequestId,
        request_no: null,
      } as RequestEventPayload,
      'cancelled',
    );
    return this.one(actor, version.assetId);
  }

  async onRequestOutcome(
    payload: RequestEventPayload,
    outcome: Outcome,
  ): Promise<void> {
    const version = (await this.versions.findFirst({
      where: { approvalRequestId: payload.request_id, status: 'pending' },
    })) as VersionRow | null;
    // Not ours, redelivered, or already settled.
    if (!version) return;
    const note =
      outcome === 'rejected'
        ? `ไม่อนุมัติ — ดูเหตุผลในคำขอ ${payload.request_no ?? ''}`.trim()
        : null;
    const moved = await this.transactions.execute(async (prisma) => {
      const result = await this.versions.updateMany(
        {
          where: { id: version.id, status: 'pending' },
          data: { status: outcome, decidedAt: new Date(), decisionNote: note },
        },
        { prisma },
      );
      if (result.count !== 1) return false;
      if (outcome === 'approved') {
        await this.assets.update(
          {
            where: { id: version.assetId },
            data: { currentVersionId: version.id },
          },
          { prisma },
        );
      }
      await this.audit.record(
        {
          eventType: `macom.brand.version_${outcome}`,
          companyId: version.companyId,
          actorId: null,
          actorUsername: 'brand-approval-sync',
          resourceType: 'brand_asset',
          resourceId: version.assetId,
          after: {
            versionNo: version.versionNo,
            requestId: payload.request_id,
          },
        },
        { prisma },
      );
      return true;
    });
    if (!moved || outcome === 'cancelled' || !version.uploadedBy) return;
    const asset = (await this.assets.findFirst({
      where: { id: version.assetId },
      select: { name: true },
    })) as { name: string } | null;
    await this.notifications
      .brandVersion(version.uploadedBy, version.companyId, {
        kind: outcome,
        assetId: version.assetId,
        name: asset?.name ?? '',
        versionNo: version.versionNo,
        reason: note ?? '',
      })
      .catch((error: unknown) =>
        this.logger.warn(`brand version notice failed: ${String(error)}`),
      );
  }

  /** An asset of the caller's company — staff only reach one with an approved version. */
  async requireAsset(
    actor: Principal,
    id: string,
    manager: boolean,
  ): Promise<AssetRow> {
    const row = (await this.assets.findFirst({
      where: {
        id,
        companyId: actor.activeCompanyId,
        ...(manager
          ? {}
          : { currentVersionId: { not: null }, retiredAt: null }),
      },
    })) as AssetRow | null;
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบไฟล์นี้ในคลังแบรนด์');
    return row;
  }

  private assetView(row: AssetRow, current: VersionRow | null) {
    return {
      id: row.id,
      category: row.category,
      name: row.name,
      description: row.description,
      tags: row.tags,
      retired: row.retiredAt !== null,
      retire_reason: row.retireReason,
      updated_at: row.updatedAt.toISOString(),
      current: current ? this.versionView(current) : null,
    };
  }

  private versionView(row: VersionRow) {
    return {
      id: row.id,
      version_no: row.versionNo,
      file_name: row.fileName,
      mime_type: row.mimeType,
      size_bytes: row.sizeBytes,
      approved_at: row.decidedAt?.toISOString() ?? null,
    };
  }

  private async namesOf(ids: (string | null)[]) {
    const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
    if (!unique.length) return new Map<string, string>();
    const users = (await this.people.findMany({
      where: { id: { in: unique } },
      select: { id: true, displayName: true },
    })) as { id: string; displayName: string }[];
    return new Map(users.map((user) => [user.id, user.displayName]));
  }
}
