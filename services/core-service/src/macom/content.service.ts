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
  PrismaTransactionService,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import { CompanyMemberRepository } from '../access/company-member.repository';
import { backgroundTick } from '../common/background-tick';
import { CampaignRepository } from '../crm/sales.repositories';
import { NotificationsService } from '../notifications/notifications.service';
import {
  canMove,
  editable,
  overdueNow,
  publishProblems,
  remindNow,
} from './content-rules';
import {
  CopyContentDto,
  ListContentQueryDto,
  MoveContentDto,
  SaveContentDto,
} from './macom.dto';
import {
  ContentFileRepository,
  ContentItemRepository,
} from './macom.repositories';

export interface ContentRow {
  id: string;
  companyId: string;
  campaignId: string | null;
  channel: string;
  title: string;
  caption: string;
  ownerUserId: string;
  plannedAt: Date;
  status: string;
  publishedAt: Date | null;
  publishedUrl: string | null;
  cancelReason: string | null;
  version: number;
  remindedAt: Date | null;
  overdueAt: Date | null;
  copiedFromId: string | null;
  createdAt: Date;
}

/** The channel's name in a notice. */
const CHANNEL_NAMES: Record<string, string> = {
  line_oa: 'LINE OA',
  facebook: 'Facebook',
  tiktok: 'TikTok',
  instagram: 'Instagram',
  website: 'เว็บไซต์',
  email: 'อีเมล',
};

const bangkok = (value: Date) =>
  new Date(value.getTime() + 7 * 3_600_000)
    .toISOString()
    .slice(0, 16)
    .replace('T', ' ');

/**
 * CD-271 — the content calendar: one post on one channel per item, planned
 * for a time, with its caption and media; draft → ready → published (with the
 * live link) or cancelled. The owner hears the day before a ready post is due
 * and when one goes an hour past its time unpublished. Posting to the
 * platforms themselves is not here — the team posts and pastes the link.
 */
@Injectable()
export class ContentService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ContentService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly items: ContentItemRepository,
    private readonly files: ContentFileRepository,
    private readonly campaigns: CampaignRepository,
    private readonly people: CompanyMemberRepository,
    private readonly notifications: NotificationsService,
    private readonly transactions: PrismaTransactionService,
    private readonly audit: AuditWriter,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const everyMs =
      this.config.get<number>('macom.contentSweepIntervalMs') ?? 900_000;
    // `0` disables — tests and external-service never sweep.
    if (everyMs <= 0) return;
    this.timer = setInterval(
      backgroundTick(this.logger, 'content calendar sweep', () => this.sweep()),
      everyMs,
    );
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async list(actor: Principal, query: ListContentQueryDto) {
    const rows = (await this.items.findMany({
      where: {
        companyId: actor.activeCompanyId,
        ...(query.channel ? { channel: query.channel } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.campaign_id ? { campaignId: query.campaign_id } : {}),
        ...(query.from || query.to
          ? {
              plannedAt: {
                ...(query.from
                  ? {
                      gte: new Date(
                        `${query.from.slice(0, 10)}T00:00:00+07:00`,
                      ),
                    }
                  : {}),
                ...(query.to
                  ? { lte: new Date(`${query.to.slice(0, 10)}T23:59:59+07:00`) }
                  : {}),
              },
            }
          : {}),
      },
      orderBy: [{ plannedAt: 'asc' }],
      take: 1000,
    })) as ContentRow[];
    return this.present(rows);
  }

  async one(actor: Principal, id: string) {
    const row = await this.require(actor, id);
    const [view] = await this.present([row]);
    const files = (await this.files.findMany({
      where: { contentId: id, removedAt: null },
      orderBy: { createdAt: 'asc' },
      select: { id: true, fileName: true, mimeType: true, sizeBytes: true },
    })) as {
      id: string;
      fileName: string;
      mimeType: string;
      sizeBytes: number;
    }[];
    return {
      ...view,
      files: files.map((file) => ({
        id: file.id,
        file_name: file.fileName,
        mime_type: file.mimeType,
        size_bytes: file.sizeBytes,
      })),
    };
  }

  async create(actor: Principal, dto: SaveContentDto) {
    const owner = await this.requireOwner(
      actor,
      dto.owner_user_id || actor.userId,
    );
    const campaignId = await this.requireCampaign(actor, dto.campaign_id);
    const row = (await this.items.create({
      data: {
        companyId: actor.activeCompanyId,
        campaignId,
        channel: dto.channel,
        title: dto.title.trim(),
        caption: dto.caption ?? '',
        ownerUserId: owner,
        plannedAt: new Date(dto.planned_at),
        createdBy: actor.userId,
        updatedBy: actor.userId,
      },
      select: { id: true },
    })) as { id: string };
    await this.audit.record({
      eventType: 'macom.content.created',
      companyId: actor.activeCompanyId,
      ...auditActor(actor),
      resourceType: 'content_item',
      resourceId: row.id,
      after: {
        title: dto.title,
        channel: dto.channel,
        plannedAt: dto.planned_at,
      },
    });
    return this.one(actor, row.id);
  }

  /**
   * Edit before it goes out. A change to the words, channel or campaign is a
   * new version (CD-272 binds approval to it); moving the time is not.
   */
  async update(actor: Principal, id: string, dto: SaveContentDto) {
    const row = await this.require(actor, id);
    if (!editable(row.status)) {
      throw new AppError(
        'CONFLICT',
        'คอนเทนต์ที่เผยแพร่หรือยกเลิกแล้วแก้ไม่ได้',
      );
    }
    const owner = await this.requireOwner(
      actor,
      dto.owner_user_id || row.ownerUserId,
    );
    const campaignId = await this.requireCampaign(actor, dto.campaign_id);
    const plannedAt = new Date(dto.planned_at);
    const changed =
      dto.title.trim() !== row.title ||
      (dto.caption ?? '') !== row.caption ||
      dto.channel !== row.channel ||
      campaignId !== row.campaignId;
    await this.items.update({
      where: { id },
      data: {
        title: dto.title.trim(),
        caption: dto.caption ?? '',
        channel: dto.channel,
        campaignId,
        ownerUserId: owner,
        plannedAt,
        ...(changed ? { version: row.version + 1 } : {}),
        // a new time is a new reminder
        ...(plannedAt.getTime() !== row.plannedAt.getTime()
          ? { remindedAt: null, overdueAt: null }
          : {}),
        updatedBy: actor.userId,
      },
    });
    await this.audit.record({
      eventType: 'macom.content.updated',
      companyId: row.companyId,
      ...auditActor(actor),
      resourceType: 'content_item',
      resourceId: id,
      before: {
        title: row.title,
        plannedAt: row.plannedAt.toISOString(),
        version: row.version,
      },
      after: {
        title: dto.title,
        plannedAt: dto.planned_at,
        version: changed ? row.version + 1 : row.version,
      },
    });
    return this.one(actor, id);
  }

  async move(actor: Principal, id: string, dto: MoveContentDto) {
    const row = await this.require(actor, id);
    if (!canMove(row.status, dto.status)) {
      throw new AppError(
        'CONFLICT',
        `เปลี่ยนจาก ${row.status} เป็น ${dto.status} ไม่ได้`,
      );
    }
    if (dto.status === 'published') {
      const problems = publishProblems(dto.published_url);
      if (problems.length) {
        throw new AppError('VALIDATION_FAILED', problems[0], [
          { field: 'published_url', reason: problems[0] },
        ]);
      }
    }
    if (dto.status === 'cancelled' && !dto.reason?.trim()) {
      throw new AppError('VALIDATION_FAILED', 'ใส่เหตุผลที่ยกเลิก', [
        { field: 'reason', reason: 'required' },
      ]);
    }
    await this.items.update({
      where: { id },
      data: {
        status: dto.status,
        ...(dto.status === 'published'
          ? { publishedAt: new Date(), publishedUrl: dto.published_url?.trim() }
          : {}),
        ...(dto.status === 'cancelled'
          ? { cancelReason: dto.reason?.trim() }
          : {}),
        ...(dto.status === 'draft' ? { cancelReason: null } : {}),
        updatedBy: actor.userId,
      },
    });
    await this.audit.record({
      eventType: `macom.content.${dto.status}`,
      companyId: row.companyId,
      ...auditActor(actor),
      resourceType: 'content_item',
      resourceId: id,
      before: { status: row.status },
      after: {
        status: dto.status,
        publishedUrl: dto.published_url ?? null,
        reason: dto.reason ?? null,
      },
    });
    return this.one(actor, id);
  }

  /** The same post for another channel — a new draft, the same media. */
  async copy(actor: Principal, id: string, dto: CopyContentDto) {
    const row = await this.require(actor, id);
    const created = await this.transactions.execute(async (prisma) => {
      const copy = await prisma.contentItem.create({
        data: {
          companyId: row.companyId,
          campaignId: row.campaignId,
          channel: dto.channel,
          title: row.title,
          caption: row.caption,
          ownerUserId: row.ownerUserId,
          plannedAt: row.plannedAt,
          copiedFromId: row.id,
          createdBy: actor.userId,
          updatedBy: actor.userId,
        },
        select: { id: true },
      });
      const media = (await prisma.contentFile.findMany({
        where: { contentId: id, removedAt: null },
      })) as {
        fileName: string;
        mimeType: string;
        sizeBytes: number;
        storageKey: string;
      }[];
      if (media.length) {
        // the object stays where it is; both posts point at it
        await prisma.contentFile.createMany({
          data: media.map((file) => ({
            companyId: row.companyId,
            contentId: copy.id,
            fileName: file.fileName,
            mimeType: file.mimeType,
            sizeBytes: file.sizeBytes,
            storageKey: file.storageKey,
            uploadedBy: actor.userId,
          })),
        });
      }
      await this.audit.record(
        {
          eventType: 'macom.content.copied',
          companyId: row.companyId,
          ...auditActor(actor),
          resourceType: 'content_item',
          resourceId: copy.id,
          after: { from: id, channel: dto.channel },
        },
        { prisma },
      );
      return copy;
    });
    return this.one(actor, created.id);
  }

  /** Reminders due now: the day before, and an hour late. */
  async sweep(now = new Date()) {
    const rows = (await this.items.findMany({
      where: {
        status: { in: ['draft', 'ready'] },
        plannedAt: { lte: new Date(now.getTime() + 24 * 3_600_000) },
        OR: [{ remindedAt: null }, { overdueAt: null }],
      },
      take: 500,
    })) as ContentRow[];
    let sent = 0;
    for (const row of rows) {
      const kind = overdueNow({ ...row, now })
        ? 'overdue'
        : remindNow({ ...row, now })
          ? 'due'
          : null;
      if (!kind) continue;
      // marked first: a failing notice must not repeat every sweep
      await this.items.update({
        where: { id: row.id },
        data: kind === 'due' ? { remindedAt: now } : { overdueAt: now },
      });
      await this.notifications
        .contentReminder(row.ownerUserId, row.companyId, {
          kind,
          contentId: row.id,
          title: row.title,
          channel: CHANNEL_NAMES[row.channel] ?? row.channel,
          plannedAt: bangkok(row.plannedAt),
        })
        .catch((error: unknown) =>
          this.logger.warn(`content reminder failed: ${String(error)}`),
        );
      sent += 1;
    }
    return { sent };
  }

  /** One item of the caller's company (404 for another company's). */
  async require(actor: Principal, id: string): Promise<ContentRow> {
    const row = (await this.items.findFirst({
      where: { id, companyId: actor.activeCompanyId },
    })) as ContentRow | null;
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบคอนเทนต์นี้');
    return row;
  }

  private async present(rows: ContentRow[]) {
    const [names, campaigns] = await Promise.all([
      this.namesOf(rows.map((row) => row.ownerUserId)),
      this.campaignNames(
        rows.flatMap((row) => (row.campaignId ? [row.campaignId] : [])),
      ),
    ]);
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      channel: row.channel,
      caption: row.caption,
      planned_at: row.plannedAt.toISOString(),
      status: row.status,
      owner: {
        id: row.ownerUserId,
        name: names.get(row.ownerUserId) ?? row.ownerUserId,
      },
      campaign: row.campaignId
        ? { id: row.campaignId, name: campaigns.get(row.campaignId) ?? '—' }
        : null,
      published_at: row.publishedAt?.toISOString() ?? null,
      published_url: row.publishedUrl,
      cancel_reason: row.cancelReason,
      version: row.version,
      copied_from_id: row.copiedFromId,
    }));
  }

  private async requireOwner(actor: Principal, userId: string) {
    const user = (await this.people.findFirst({
      where: {
        id: userId,
        status: 'ACTIVE',
        companies: { some: { companyId: actor.activeCompanyId } },
      },
      select: { id: true },
    })) as { id: string } | null;
    if (!user) {
      throw new AppError(
        'VALIDATION_FAILED',
        'ผู้รับผิดชอบไม่ได้อยู่ในบริษัทนี้',
        [{ field: 'owner_user_id', reason: 'not_member' }],
      );
    }
    return user.id;
  }

  private async requireCampaign(actor: Principal, campaignId?: string) {
    const id = campaignId?.trim();
    if (!id) return null;
    const found = await this.campaigns.findFirst({
      where: { id, companyId: actor.activeCompanyId },
      select: { id: true },
    });
    if (!found) {
      throw new AppError('VALIDATION_FAILED', 'ไม่พบแคมเปญนี้', [
        { field: 'campaign_id', reason: 'not_found' },
      ]);
    }
    return id;
  }

  private async namesOf(ids: string[]) {
    const unique = [...new Set(ids)];
    if (!unique.length) return new Map<string, string>();
    const users = (await this.people.findMany({
      where: { id: { in: unique } },
      select: { id: true, displayName: true },
    })) as { id: string; displayName: string }[];
    return new Map(users.map((user) => [user.id, user.displayName]));
  }

  private async campaignNames(ids: string[]) {
    const unique = [...new Set(ids)];
    if (!unique.length) return new Map<string, string>();
    const rows = (await this.campaigns.findMany({
      where: { id: { in: unique } },
      select: { id: true, name: true },
    })) as { id: string; name: string }[];
    return new Map(rows.map((row) => [row.id, row.name]));
  }
}
