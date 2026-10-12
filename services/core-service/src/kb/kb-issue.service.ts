import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditWriter } from '@request-management/share';
import { backgroundTick } from '../common/background-tick';
import { IssueResolvedHooks } from '../pm/issue-hooks';
import {
  ProjectIssueRepository,
  ProjectRepository,
} from '../pm/project.repositories';
import { articleFromIssue, productCodesOf } from './kb-field-rules';
import { KbReviewService } from './kb-review.service';
import { KbService } from './kb.service';

const DEFAULT_INTERVAL_MS = 3_600_000;

interface IssueRow {
  id: string;
  companyId: string;
  projectId: string;
  seq: number;
  title: string;
  description: string | null;
  cause: string | null;
  resolution: string | null;
  resolvedBy: string | null;
  ownerUserId: string;
  kbmsStatus: string | null;
}

const ISSUE_SELECT = {
  id: true,
  companyId: true,
  projectId: true,
  seq: true,
  title: true,
  description: true,
  cause: true,
  resolution: true,
  resolvedBy: true,
  ownerUserId: true,
  kbmsStatus: true,
} as const;

/**
 * CD-223 แก้ปัญหาทางเทคนิค (CD-19 Engineer) — a technical issue resolved on
 * a project (CD-184, `kind = technical`) becomes a draft in the knowledge
 * base — symptom, cause, fix — written by whoever resolved it and sent for
 * review (CD-260) at once, as the field knowledge of CD-262 is. It happens
 * when the issue is resolved; the sweep takes any the moment missed. The
 * issue is then `sent`, with the article number.
 */
@Injectable()
export class KbIssueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KbIssueService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly issues: ProjectIssueRepository,
    private readonly projects: ProjectRepository,
    private readonly kb: KbService,
    private readonly review: KbReviewService,
    private readonly hooks: IssueResolvedHooks,
    private readonly audit: AuditWriter,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    this.hooks.on((issueId) => this.sendIssue(issueId));
    const interval =
      this.config.get<number>('kb.ingestIntervalMs') ?? DEFAULT_INTERVAL_MS;
    if (interval <= 0) return;
    this.timer = setInterval(
      backgroundTick(this.logger, 'CD-223 technical issues', () =>
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

  /** Resolved technical issues not yet in the knowledge base. */
  async sweep() {
    const rows = (await this.issues.findMany({
      where: { kbmsStatus: 'pending', status: 'resolved' },
      select: { id: true },
      take: 200,
    })) as { id: string }[];
    let sent = 0;
    for (const row of rows) {
      try {
        if (await this.sendIssue(row.id)) sent += 1;
      } catch (error) {
        this.logger.warn(
          `issue ${row.id} not sent: ${(error as Error).message}`,
        );
      }
    }
    return { sent };
  }

  /** One issue → a draft in review. Null when it is not waiting. */
  async sendIssue(issueId: string) {
    const issue = (await this.issues.findFirst({
      where: { id: issueId },
      select: ISSUE_SELECT,
    })) as IssueRow | null;
    if (!issue || issue.kbmsStatus !== 'pending') return null;
    // claimed first: two runs at once write one draft
    const claimed = await this.issues.updateMany({
      where: { id: issueId, kbmsStatus: 'pending' },
      data: { kbmsStatus: 'sending' },
    });
    if (claimed.count !== 1) return null;
    try {
      const project = (await this.projects.findFirst({
        where: { id: issue.projectId },
        select: { projectNo: true, baseline: true },
      })) as { projectNo: string; baseline: unknown } | null;
      const content = articleFromIssue({
        projectNo: project?.projectNo ?? '',
        seq: issue.seq,
        title: issue.title,
        description: issue.description,
        cause: issue.cause,
        resolution: issue.resolution,
      });
      const author = issue.resolvedBy ?? issue.ownerUserId;
      const article = await this.kb.insertDraft(
        issue.companyId,
        author,
        {
          title: content.title,
          body: content.body,
          productCodes: productCodesOf(project?.baseline),
        },
        { source: 'project_issue', sourceRef: content.sourceRef },
      );
      await this.review.submitSystemDraft(article.id);
      await this.issues.update({
        where: { id: issueId },
        data: { kbmsStatus: 'sent', kbmsRef: article.articleNo },
      });
      await this.audit.record({
        eventType: 'kb.issue.sent',
        companyId: issue.companyId,
        actorId: null,
        actorUsername: 'system',
        resourceType: 'project_issue',
        resourceId: issueId,
        after: { articleNo: article.articleNo, sourceRef: content.sourceRef },
      });
      return { articleNo: article.articleNo };
    } catch (error) {
      // back in the queue for the sweep
      await this.issues.updateMany({
        where: { id: issueId, kbmsStatus: 'sending' },
        data: { kbmsStatus: 'pending' },
      });
      throw error;
    }
  }
}
