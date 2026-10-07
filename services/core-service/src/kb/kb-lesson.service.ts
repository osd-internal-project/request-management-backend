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
} from '@request-management/share';
import { backgroundTick } from '../common/background-tick';
import { NotificationsService } from '../notifications/notifications.service';
import {
  ProjectBudgetRepository,
  ProjectLessonRepository,
  ProjectRepository,
} from '../pm/project.repositories';
import { appendLessons, articleFromLessons } from './kb-field-rules';
import { KbArticleRepository } from './kb.repositories';
import { KbService } from './kb.service';

const DEFAULT_INTERVAL_MS = 3_600_000;

interface ProjectRow {
  id: string;
  companyId: string;
  projectNo: string;
  name: string;
  managerUserId: string;
  status: string;
}

/**
 * CD-263 ความรู้จากบทเรียนปิดโครงการ (part of CD-22 KBMS) — the lessons a
 * project writes at close-out (CD-191, `went_well` · `improve` ·
 * `recommend`) become one draft per project, owned by its manager, who trims
 * the customer and prices out and sends it for review (CD-260). It happens
 * when the project is closed, or earlier when the manager asks; lessons
 * written after are added to the draft while it is still a draft, else a new
 * draft takes them. Each lesson is then `sent`, with the article number.
 */
@Injectable()
export class KbLessonService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KbLessonService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly projects: ProjectRepository,
    private readonly lessons: ProjectLessonRepository,
    private readonly budgets: ProjectBudgetRepository,
    private readonly articles: KbArticleRepository,
    private readonly kb: KbService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditWriter,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const interval =
      this.config.get<number>('kb.ingestIntervalMs') ?? DEFAULT_INTERVAL_MS;
    if (interval <= 0) return;
    this.timer = setInterval(
      backgroundTick(this.logger, 'CD-263 project lessons', () => this.sweep()),
      interval,
    );
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** The manager (or `pm.project.manage`) sends the lessons now. */
  async send(actor: Principal, projectId: string) {
    const project = await this.project(actor.activeCompanyId, projectId);
    if (
      project.managerUserId !== actor.userId &&
      !hasPermission(actor, 'pm.project.manage')
    )
      throw new AppError('FORBIDDEN', 'ส่งบทเรียนได้เฉพาะผู้จัดการโครงการ');
    const result = await this.sendFor(project);
    if (!result) throw new AppError('CONFLICT', 'ไม่มีบทเรียนที่รอส่ง');
    await this.audit.record({
      eventType: 'kb.lessons.sent',
      companyId: project.companyId,
      ...auditActor(actor),
      resourceType: 'project',
      resourceId: project.id,
      after: { articleNo: result.articleNo, lessons: result.lessons },
    });
    return result;
  }

  /** Closed projects with lessons still pending. */
  async sweep() {
    const rows = (await this.projects.findMany({
      where: {
        status: 'closed',
        lessons: { some: { kbmsStatus: 'pending', deletedAt: null } },
      },
      select: {
        id: true,
        companyId: true,
        projectNo: true,
        name: true,
        managerUserId: true,
        status: true,
      },
      take: 200,
    })) as ProjectRow[];
    let sent = 0;
    for (const project of rows) {
      try {
        if (await this.sendFor(project)) sent += 1;
      } catch (error) {
        this.logger.warn(
          `lessons of ${project.projectNo} not sent: ${(error as Error).message}`,
        );
      }
    }
    return { sent };
  }

  /** Pending lessons → the project's draft (added to, or a new one). Null if none. */
  async sendFor(project: ProjectRow) {
    const pending = (await this.lessons.findMany({
      where: { projectId: project.id, kbmsStatus: 'pending', deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: { id: true, kind: true, text: true },
    })) as { id: string; kind: string; text: string }[];
    if (!pending.length) return null;

    const draft = (await this.articles.findFirst({
      where: {
        companyId: project.companyId,
        source: 'lesson',
        sourceRef: project.projectNo,
        status: 'draft',
      },
      select: { id: true, articleNo: true, body: true },
    })) as { id: string; articleNo: string; body: string } | null;

    let article: { id: string; articleNo: string; title: string };
    let added = false;
    if (draft) {
      await this.articles.update({
        where: { id: draft.id },
        data: { body: appendLessons(draft.body, pending) },
      });
      article = { id: draft.id, articleNo: draft.articleNo, title: '' };
      added = true;
    } else {
      const content = articleFromLessons(project, pending);
      const row = await this.kb.insertDraft(
        project.companyId,
        project.managerUserId,
        {
          title: content.title,
          body: content.body,
          productCodes: await this.materialCodes(project.id),
        },
        { source: 'lesson', sourceRef: content.sourceRef },
      );
      article = { id: row.id, articleNo: row.articleNo, title: row.title };
    }
    await this.lessons.updateMany({
      where: { id: { in: pending.map((l) => l.id) } },
      data: { kbmsStatus: 'sent', kbmsRef: article.articleNo },
    });
    await this.notifications.kbLessonsDrafted(
      project.managerUserId,
      project.companyId,
      { id: article.id, articleNo: article.articleNo },
      `${project.projectNo} · ${project.name}`,
      pending.length,
    );
    return {
      articleId: article.id,
      articleNo: article.articleNo,
      lessons: pending.length,
      added,
    };
  }

  /** SAP item codes on the material lines of the project's latest locked budget. */
  private async materialCodes(projectId: string) {
    const budget = (await this.budgets.findFirst({
      where: { projectId, status: 'locked' },
      orderBy: { versionNo: 'desc' },
      select: { lines: true },
    })) as { lines: unknown } | null;
    const lines = Array.isArray(budget?.lines)
      ? (budget.lines as { category?: string; code?: string }[])
      : [];
    return [
      ...new Set(
        lines
          .filter(
            (l) =>
              l.category === 'material' &&
              typeof l.code === 'string' &&
              l.code.trim(),
          )
          .map((l) => l.code!.trim()),
      ),
    ].slice(0, 50);
  }

  private async project(companyId: string, id: string) {
    const row = (await this.projects.findFirst({
      where: { id, companyId },
      select: {
        id: true,
        companyId: true,
        projectNo: true,
        name: true,
        managerUserId: true,
        status: true,
      },
    })) as ProjectRow | null;
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบโครงการที่ระบุ');
    return row;
  }
}
