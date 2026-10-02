import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  AppError,
  AuditWriter,
  auditActor,
  OBJECT_STORAGE,
  Principal,
  PrismaTransactionService,
} from '@request-management/share';
import type { ObjectStorage } from '@request-management/share';
import { CompanyMemberRepository } from '../access/company-member.repository';
import { bangkokDay } from '../crm/kyc-rules';
import { NotificationsService } from '../notifications/notifications.service';
import { safeFileName } from '../requests/attachments.service';
import { SaveTestItemDto } from './dto/project.dto';
import { EVIDENCE_TYPES, MAX_EVIDENCE_BYTES } from './milestones.service';
import {
  ProjectChangeRequestRepository,
  ProjectRepository,
  ProjectTestItemRepository,
  ProjectTestRunRepository,
} from './project.repositories';
import { ProjectsService } from './projects.service';
import { TaskEvidenceService } from './task-evidence.service';
import {
  issueFromFailure,
  MAX_TEST_TEXT,
  resultProblems,
  testCoverage,
  testSources,
  testState,
} from './test-rules';

interface RunRow {
  id: string;
  result: string;
  note: string | null;
  evidenceName: string | null;
  issueId: string | null;
  testedBy: string;
  testedAt: Date;
}

interface ItemRow {
  id: string;
  companyId: string;
  projectId: string;
  seq: number;
  source: string;
  sourceRef: string | null;
  deliverable: string | null;
  text: string;
  steps: string | null;
  taskId: string | null;
  ownerUserId: string | null;
  waivedReason: string | null;
  waivedAt: Date | null;
  runs: RunRow[];
}

interface UploadedEvidence {
  readonly originalname: string;
  readonly mimetype: string;
  readonly size: number;
  readonly buffer: Buffer;
}

type Access = Awaited<ReturnType<ProjectsService['access']>>;

/** Days the manager is given to see a failed test fixed. */
const FAILURE_ISSUE_DAYS = 7;

/**
 * CD-221 ทดสอบ — the test plan of a project, item by item against what was
 * sold: every scope line and deliverable criterion of the baseline, and the
 * scope approved change requests added (kept in step on every read), plus
 * items the manager adds. Anyone on the team records a result with its
 * evidence; a failure opens an issue (CD-184) for the manager. Coverage —
 * every item that applies passed — is handoff 8 (Engineer → Delivery) and
 * what acceptance (CD-189) waits for.
 *
 * Who: whoever sees the project reads it; the team records results;
 * `pm.project.manage` or the project's manager plans it (adds items, writes
 * how to test, assigns, waives).
 */
@Injectable()
export class TestsService {
  private readonly logger = new Logger(TestsService.name);

  constructor(
    private readonly projects: ProjectsService,
    private readonly projectRows: ProjectRepository,
    private readonly changes: ProjectChangeRequestRepository,
    private readonly items: ProjectTestItemRepository,
    private readonly runs: ProjectTestRunRepository,
    private readonly people: CompanyMemberRepository,
    private readonly notifications: NotificationsService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
    private readonly taskEvidence: TaskEvidenceService,
  ) {}

  async view(projectId: string, actor: Principal) {
    const access = await this.projects.access(projectId, actor);
    await this.sync(access);
    const [rows, tasks] = await Promise.all([
      this.rows(projectId),
      this.taskEvidence.options(projectId),
    ]);
    const names = await this.displayNames([
      ...rows.map((row) => row.ownerUserId),
      ...rows.flatMap((row) => row.runs.map((run) => run.testedBy)),
    ]);
    const issueNos = await this.issueNos(
      rows.flatMap((row) => row.runs.map((run) => run.issueId)),
    );
    const states = rows.map((row) => testState(row));
    return {
      canEdit: access.canEdit,
      canWrite: this.mayWrite(access, actor),
      coverage: testCoverage(states),
      tasks,
      items: rows.map((row, index) => ({
        id: row.id,
        label: `T-${row.seq}`,
        source: row.source,
        deliverable: row.deliverable,
        text: row.text,
        steps: row.steps,
        taskId: row.taskId,
        taskLabel: tasks.find((task) => task.id === row.taskId)?.label ?? null,
        ownerUserId: row.ownerUserId,
        ownerName: row.ownerUserId
          ? (names.get(row.ownerUserId) ?? null)
          : null,
        state: states[index],
        waivedReason: row.waivedReason,
        runs: row.runs.map((run) => ({
          id: run.id,
          result: run.result,
          note: run.note,
          evidenceName: run.evidenceName,
          issue: run.issueId
            ? { id: run.issueId, label: issueNos.get(run.issueId) ?? null }
            : null,
          testedByName: names.get(run.testedBy) ?? run.testedBy,
          testedAt: run.testedAt,
        })),
      })),
    };
  }

  /** For acceptance (CD-189): the coverage, and what is still open. */
  async coverage(projectId: string) {
    const rows = await this.rows(projectId);
    const states = rows.map((row) => testState(row));
    return {
      ...testCoverage(states),
      open: rows.flatMap((row, index) =>
        states[index] === 'untested' || states[index] === 'failed'
          ? [{ label: `T-${row.seq}`, text: row.text, state: states[index] }]
          : [],
      ),
    };
  }

  // --- the plan (the manager) ---------------------------------------------------

  async add(projectId: string, dto: SaveTestItemDto, actor: Principal) {
    const access = await this.editable(projectId, actor);
    const text = (dto.text ?? '').trim();
    if (!text || text.length > MAX_TEST_TEXT) {
      throw new AppError(
        'VALIDATION_FAILED',
        `ต้องระบุข้อที่ทดสอบ (ไม่เกิน ${MAX_TEST_TEXT} ตัวอักษร)`,
      );
    }
    const owner = dto.owner_user_id || null;
    if (owner) await this.assertPerson(access.project.companyId, owner);
    const taskId = dto.task_id || null;
    await this.taskEvidence.assertTask(projectId, taskId);
    await this.transactions.execute(async (prisma) => {
      const last = await prisma.projectTestItem.findFirst({
        where: { projectId },
        orderBy: { seq: 'desc' },
        select: { seq: true },
      });
      const row = await prisma.projectTestItem.create({
        data: {
          companyId: access.project.companyId,
          projectId,
          seq: (last?.seq ?? 0) + 1,
          source: 'manual',
          text,
          steps: dto.steps?.trim() || null,
          ownerUserId: owner,
          taskId,
          createdBy: actor.userId,
        },
        select: { id: true },
      });
      await this.audit.record(
        {
          eventType: 'pm.test.item_added',
          companyId: access.project.companyId,
          ...auditActor(actor),
          resourceType: 'project',
          resourceId: projectId,
          after: { itemId: row.id, text },
        },
        { prisma },
      );
    });
    await this.taskEvidence.sync(projectId, [taskId], actor);
    return this.view(projectId, actor);
  }

  /**
   * How to test it, who tests it, waived (with the reason) or not; the text
   * only of an item added by hand — the others are what was sold.
   */
  async update(
    projectId: string,
    itemId: string,
    dto: SaveTestItemDto,
    actor: Principal,
    now = new Date(),
  ) {
    const access = await this.editable(projectId, actor);
    const item = await this.requireItem(projectId, itemId);
    if (dto.text !== undefined && item.source !== 'manual') {
      throw new AppError(
        'CONFLICT',
        'ข้อที่มาจากขอบเขตงานแก้ข้อความไม่ได้ — เปลี่ยนขอบเขตต้องผ่านคำขอเปลี่ยนแปลง',
      );
    }
    const text = dto.text === undefined ? undefined : dto.text.trim();
    if (text !== undefined && (!text || text.length > MAX_TEST_TEXT)) {
      throw new AppError('VALIDATION_FAILED', 'ต้องระบุข้อที่ทดสอบ');
    }
    if (dto.owner_user_id) {
      await this.assertPerson(access.project.companyId, dto.owner_user_id);
    }
    const taskId = dto.task_id === undefined ? undefined : dto.task_id || null;
    if (taskId) await this.taskEvidence.assertTask(projectId, taskId);
    const waive =
      dto.waived_reason === undefined
        ? undefined
        : dto.waived_reason.trim() || null;
    const data = {
      text,
      steps: dto.steps === undefined ? undefined : dto.steps.trim() || null,
      ownerUserId:
        dto.owner_user_id === undefined ? undefined : dto.owner_user_id || null,
      taskId,
      ...(waive === undefined
        ? {}
        : waive
          ? { waivedReason: waive, waivedAt: now, waivedBy: actor.userId }
          : { waivedReason: null, waivedAt: null, waivedBy: null }),
      updatedBy: actor.userId,
    };
    await this.transactions.execute(async (prisma) => {
      await this.items.update({ where: { id: itemId }, data }, { prisma });
      await this.audit.record(
        {
          eventType: 'pm.test.item_updated',
          companyId: access.project.companyId,
          ...auditActor(actor),
          resourceType: 'project',
          resourceId: projectId,
          before: {
            itemId,
            text: item.text,
            ownerUserId: item.ownerUserId,
            waivedReason: item.waivedReason,
          },
          after: { itemId, ...dto },
        },
        { prisma },
      );
    });
    await this.taskEvidence.sync(
      projectId,
      [item.taskId, taskId ?? null],
      actor,
      now,
    );
    await this.taskEvidence.syncSow(projectId, item.sourceRef, actor, now);
    return this.view(projectId, actor);
  }

  // --- results (the team) -----------------------------------------------------------

  async record(
    projectId: string,
    itemId: string,
    body: { result?: string; note?: string },
    file: UploadedEvidence | undefined,
    actor: Principal,
    now = new Date(),
  ) {
    const access = await this.projects.access(projectId, actor);
    if (!this.mayWrite(access, actor)) {
      throw new AppError(
        'FORBIDDEN',
        'บันทึกผลทดสอบได้เฉพาะทีมโครงการ ขณะโครงการยังดำเนินอยู่',
      );
    }
    const item = await this.requireItem(projectId, itemId);
    const result = (body.result ?? '').trim();
    const note = (body.note ?? '').trim();
    const problems = resultProblems({
      result,
      note,
      hasFile: Boolean(file),
      waived: Boolean(item.waivedAt),
    });
    if (
      file &&
      !(EVIDENCE_TYPES as readonly string[]).includes(file.mimetype)
    ) {
      problems.push('แนบได้เฉพาะรูป PDF Word หรือ Excel');
    }
    if (file && file.size > MAX_EVIDENCE_BYTES) {
      problems.push('ไฟล์ใหญ่เกิน 25 MB');
    }
    if (problems.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        problems[0],
        problems.map((reason) => ({ field: 'result', reason })),
      );
    }
    const runId = randomUUID();
    let evidence: { key: string; name: string } | null = null;
    if (file) {
      const name = safeFileName(file.originalname);
      const key = `projects/${projectId}/tests/${itemId}/${runId}/${name}`;
      await this.storage.put(key, file.buffer, {
        contentType: file.mimetype,
        size: file.size,
      });
      evidence = { key, name };
    }
    const label = `T-${item.seq}`;
    const project = access.project;
    let opened: { id: string; seq: number; title: string } | null = null;
    try {
      opened = await this.transactions.execute(async (prisma) => {
        let issue: { id: string; seq: number; title: string } | null = null;
        if (result === 'fail') {
          const last = await prisma.projectIssue.findFirst({
            where: { projectId },
            orderBy: { seq: 'desc' },
            select: { seq: true },
          });
          const due = new Date(
            new Date(`${bangkokDay(now)}T00:00:00Z`).getTime() +
              FAILURE_ISSUE_DAYS * 86_400_000,
          );
          const words = issueFromFailure({
            label,
            text: item.text,
            note,
            tester: actor.displayName || actor.userId,
          });
          issue = await prisma.projectIssue.create({
            data: {
              companyId: project.companyId,
              projectId,
              seq: (last?.seq ?? 0) + 1,
              title: words.title,
              description: words.description,
              severity: 'medium',
              ownerUserId: project.managerUserId,
              dueOn: due,
              createdBy: actor.userId,
            },
            select: { id: true, seq: true, title: true },
          });
        }
        await prisma.projectTestRun.create({
          data: {
            id: runId,
            companyId: project.companyId,
            itemId,
            result,
            note: note || null,
            evidenceKey: evidence?.key ?? null,
            evidenceName: evidence?.name ?? null,
            evidenceMime: file?.mimetype ?? null,
            evidenceSize: file?.size ?? null,
            issueId: issue?.id ?? null,
            testedBy: actor.userId,
            testedAt: now,
          },
        });
        await this.audit.record(
          {
            eventType: 'pm.test.recorded',
            companyId: project.companyId,
            ...auditActor(actor),
            resourceType: 'project',
            resourceId: projectId,
            after: {
              itemId,
              label,
              result,
              evidence: evidence?.name ?? null,
              issueId: issue?.id ?? null,
            },
          },
          { prisma },
        );
        return issue;
      });
    } catch (error) {
      if (evidence)
        await this.storage.remove(evidence.key).catch(() => undefined);
      throw error;
    }
    if (opened && project.managerUserId !== actor.userId) {
      await this.notifications
        .issueAssigned(
          project.managerUserId,
          project.companyId,
          project,
          `I-${opened.seq}`,
          opened.title,
        )
        .catch((error: Error) =>
          this.logger.warn(`test failure notice not sent: ${error.message}`),
        );
    }
    // CD-218 — the task this item proves follows it
    await this.taskEvidence.sync(projectId, [item.taskId], actor, now);
    await this.taskEvidence.syncSow(projectId, item.sourceRef, actor, now);
    return this.view(projectId, actor);
  }

  async evidence(
    projectId: string,
    itemId: string,
    runId: string,
    actor: Principal,
  ): Promise<{ stream: Readable; fileName: string; mimeType: string }> {
    await this.projects.access(projectId, actor);
    const run = (await this.runs.findFirst({
      where: { id: runId, itemId, item: { projectId } },
      select: { evidenceKey: true, evidenceName: true, evidenceMime: true },
    })) as {
      evidenceKey: string | null;
      evidenceName: string | null;
      evidenceMime: string | null;
    } | null;
    if (!run?.evidenceKey) throw new AppError('NOT_FOUND', 'ไม่พบไฟล์หลักฐาน');
    return {
      stream: await this.storage.get(run.evidenceKey),
      fileName: run.evidenceName ?? 'evidence',
      mimeType: run.evidenceMime ?? 'application/octet-stream',
    };
  }

  // --- helpers -----------------------------------------------------------------------

  /** Items for what the baseline and approved changes ask, made once each. */
  private async sync(access: Access) {
    const projectId = access.project.id;
    const [project, approved, existing] = await Promise.all([
      this.projectRows.findFirst({
        where: { id: projectId },
        select: { baseline: true },
      }) as Promise<{ baseline: unknown } | null>,
      this.changes.findMany({
        where: { projectId, status: 'approved' },
        orderBy: { seq: 'asc' },
        select: { id: true, seq: true, scopeAdded: true },
      }) as Promise<{ id: string; seq: number; scopeAdded: string | null }[]>,
      this.items.findMany({
        where: { projectId },
        select: { sourceRef: true, seq: true },
      }) as Promise<{ sourceRef: string | null; seq: number }[]>,
    ]);
    const have = new Set(existing.map((row) => row.sourceRef));
    const missing = testSources(project?.baseline, approved).filter(
      (item) => !have.has(item.sourceRef),
    );
    if (!missing.length) return;
    let seq = existing.reduce((max, row) => Math.max(max, row.seq), 0);
    try {
      await this.items.createMany({
        data: missing.map((item) => ({
          companyId: access.project.companyId,
          projectId,
          seq: ++seq,
          source: item.source,
          sourceRef: item.sourceRef,
          deliverable: item.deliverable,
          text: item.text,
          createdBy: 'system',
        })),
        skipDuplicates: true,
      });
    } catch (error) {
      // two readers at once: the other one made them
      this.logger.warn(
        `test items not synced: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async rows(projectId: string) {
    return (await this.items.findMany({
      where: { projectId, deletedAt: null },
      orderBy: { seq: 'asc' },
      include: {
        runs: {
          orderBy: { testedAt: 'desc' },
          select: {
            id: true,
            result: true,
            note: true,
            evidenceName: true,
            issueId: true,
            testedBy: true,
            testedAt: true,
          },
        },
      },
    })) as unknown as ItemRow[];
  }

  private async requireItem(projectId: string, itemId: string) {
    const item = (await this.items.findFirst({
      where: { id: itemId, projectId, deletedAt: null },
    })) as Omit<ItemRow, 'runs'> | null;
    if (!item) throw new AppError('NOT_FOUND', 'ไม่พบข้อทดสอบ');
    return item;
  }

  private async editable(projectId: string, actor: Principal) {
    const access = await this.projects.access(projectId, actor);
    if (!access.canEdit) {
      throw new AppError(
        'FORBIDDEN',
        'จัดแผนทดสอบได้เฉพาะผู้จัดการโครงการ หรือผู้มีสิทธิ์จัดการโครงการ',
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

  private async assertPerson(companyId: string, userId: string) {
    const found = await this.people.count({
      where: { id: userId, companies: { some: { companyId } } },
    });
    if (!found) {
      throw new AppError('VALIDATION_FAILED', 'ผู้ทดสอบไม่ได้อยู่ในบริษัทนี้', [
        { field: 'owner_user_id', reason: 'not_found' },
      ]);
    }
  }

  private async issueNos(ids: (string | null)[]) {
    const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
    if (!unique.length) return new Map<string, string>();
    const rows = (await this.projectRows.findFirst({
      where: { issues: { some: { id: { in: unique } } } },
      select: {
        issues: {
          where: { id: { in: unique } },
          select: { id: true, seq: true },
        },
      },
    })) as { issues: { id: string; seq: number }[] } | null;
    return new Map((rows?.issues ?? []).map((row) => [row.id, `I-${row.seq}`]));
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
