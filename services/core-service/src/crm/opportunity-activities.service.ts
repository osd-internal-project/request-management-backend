import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  AppError,
  AuditWriter,
  auditActor,
  Principal,
  PrismaTransactionService,
  salesAccessSubject,
  TQueryClient,
  visibleSalesWhere,
} from '@request-management/share';
import { CompanyMemberRepository } from '../access/company-member.repository';
import {
  OpportunityActivityRepository,
  OpportunityRepository,
} from './sales.repositories';
import { CustomerTimelineService } from './customer-timeline.service';
import {
  CreateLeadActivityDto,
  UpdateLeadActivityDto,
} from './dto/sales.dto';

interface VisibleOpportunity {
  id: string;
  opportunityCode: string;
  stage: string;
  customerId: string | null;
}

/**
 * CD-65 กิจกรรมและการติดตามบนโอกาสการขาย — "บันทึกการโทร ประชุม อีเมล และ
 * กำหนดวันติดตามครั้งถัดไป". รูปแบบเดียวกับกิจกรรมของ Lead: ไม่มีกำหนด =
 * บันทึกสิ่งที่ทำไปแล้ว (เสร็จทันที), มีกำหนด = นัดติดตามที่ต้องตามต่อ.
 *
 * ทุกการเปลี่ยนแปลงคำนวณ `lastActivityAt` / `nextFollowUpAt` บนแถวโอกาสการขาย
 * ใหม่ใน transaction เดียวกัน — สองค่านี้คือสิ่งที่ `OpportunityStaleMonitorService`
 * และหน้ารายการอ่าน จึงต้องไม่มีทางเขียนกิจกรรมโดยไม่ผ่านที่นี่.
 */
@Injectable()
export class OpportunityActivitiesService {
  constructor(
    private readonly opportunities: OpportunityRepository,
    private readonly activities: OpportunityActivityRepository,
    private readonly members: CompanyMemberRepository,
    private readonly timeline: CustomerTimelineService,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
  ) {}

  /** กิจกรรมทั้งหมดของโอกาสการขายนี้ ใหม่สุดก่อน — อ่านได้แม้ปิดแล้ว. */
  async list(id: string, actor: Principal) {
    await this.requireVisible(id, actor);

    const rows = (await this.activities.findMany({
      where: { opportunityId: id },
      orderBy: { createdAt: 'desc' },
    })) as ({ createdBy: string; completedBy: string | null } & Record<
      string,
      unknown
    >)[];

    const nameOf = await this.displayNames(
      rows.flatMap((row) => [row.createdBy, row.completedBy]),
    );

    return rows.map((row) => ({
      ...row,
      createdByName: nameOf.get(row.createdBy) ?? row.createdBy,
      completedByName: row.completedBy
        ? (nameOf.get(row.completedBy) ?? row.completedBy)
        : null,
    }));
  }

  /** ลงกิจกรรม — เฉพาะโอกาสการขายที่ยังเปิดอยู่. */
  async add(id: string, dto: CreateLeadActivityDto, actor: Principal) {
    const found = await this.requireOpen(id, actor);

    const dueAt = dto.due_at ? new Date(dto.due_at) : null;
    const done = dueAt === null;

    return this.transactions.execute(async (prisma) => {
      const activity = (await this.activities.create(
        {
          data: {
            companyId: actor.activeCompanyId,
            opportunityId: id,
            type: dto.type,
            subject: dto.subject.trim(),
            detail: dto.detail?.trim() || null,
            dueAt,
            completedAt: done ? new Date() : null,
            completedBy: done ? actor.userId : null,
            createdBy: actor.userId,
          },
        },
        { prisma },
      )) as { id: string };

      await this.refreshSummary(id, prisma);

      await this.audit.record(
        {
          eventType: 'crm.opportunity.activity_logged',
          companyId: actor.activeCompanyId,
          ...auditActor(actor),
          resourceType: 'opportunity',
          resourceId: id,
          after: {
            activityId: activity.id,
            type: dto.type,
            subject: dto.subject,
            dueAt: dueAt?.toISOString() ?? null,
          },
        },
        { prisma },
      );

      if (found.customerId) {
        await this.timeline.publish(
          {
            companyId: actor.activeCompanyId,
            customerId: found.customerId,
            refType: 'opportunity',
            refId: id,
            eventType: done
              ? 'opportunity.activity_logged'
              : 'opportunity.follow_up_scheduled',
            summary: done
              ? `${found.opportunityCode}: ${dto.subject.trim()}`
              : `${found.opportunityCode}: นัดติดตาม — ${dto.subject.trim()}`,
            actorId: auditActor(actor).actorId,
            actorName: actor.displayName,
          },
          { prisma },
        );
      }

      return activity;
    });
  }

  /** ติ๊กเสร็จ / เปิดกลับ / แก้หัวข้อ-กำหนด. The row must belong to this opportunity. */
  async update(
    id: string,
    activityId: string,
    dto: UpdateLeadActivityDto,
    actor: Principal,
  ) {
    await this.requireOpen(id, actor);

    const activity = (await this.activities.findFirst({
      where: { id: activityId, opportunityId: id },
      select: { id: true },
    })) as { id: string } | null;
    if (!activity) throw new AppError('NOT_FOUND', 'ไม่พบกิจกรรมที่ระบุ');

    const data: Prisma.OpportunityActivityUncheckedUpdateInput = {};
    if (dto.subject !== undefined) data.subject = dto.subject.trim();
    if (dto.detail !== undefined) data.detail = dto.detail?.trim() || null;
    if (dto.due_at !== undefined) {
      data.dueAt = dto.due_at ? new Date(dto.due_at) : null;
    }
    if (dto.completed !== undefined) {
      data.completedAt = dto.completed ? new Date() : null;
      data.completedBy = dto.completed ? actor.userId : null;
    }

    return this.transactions.execute(async (prisma) => {
      const updated = await this.activities.update(
        { where: { id: activityId }, data },
        { prisma },
      );

      await this.refreshSummary(id, prisma);

      if (dto.completed !== undefined) {
        await this.audit.record(
          {
            eventType: dto.completed
              ? 'crm.opportunity.activity_completed'
              : 'crm.opportunity.activity_reopened',
            companyId: actor.activeCompanyId,
            ...auditActor(actor),
            resourceType: 'opportunity',
            resourceId: id,
            after: { activityId },
          },
          { prisma },
        );
      }

      return updated;
    });
  }

  /**
   * `lastActivityAt` = กิจกรรมที่เสร็จล่าสุด, `nextFollowUpAt` = กำหนดของนัดที่
   * ยังไม่เสร็จที่ใกล้ที่สุด. มีกิจกรรมใหม่เสร็จหลังการแจ้งเตือน = ล้าง
   * `staleAlertedAt` เพื่อให้ถูกนับรอบใหม่ได้ถ้าเงียบไปอีก.
   */
  private async refreshSummary(id: string, prisma: TQueryClient) {
    const [lastDone, nextDue, current] = await Promise.all([
      prisma.opportunityActivity.findFirst({
        where: { opportunityId: id, completedAt: { not: null } },
        orderBy: { completedAt: 'desc' },
        select: { completedAt: true },
      }),
      prisma.opportunityActivity.findFirst({
        where: {
          opportunityId: id,
          completedAt: null,
          dueAt: { not: null },
        },
        orderBy: { dueAt: 'asc' },
        select: { dueAt: true },
      }),
      prisma.opportunity.findUnique({
        where: { id },
        select: { staleAlertedAt: true },
      }),
    ]);

    const lastActivityAt = lastDone?.completedAt ?? null;
    const alertCleared =
      current?.staleAlertedAt &&
      lastActivityAt &&
      lastActivityAt > current.staleAlertedAt;

    await prisma.opportunity.update({
      where: { id },
      data: {
        lastActivityAt,
        nextFollowUpAt: nextDue?.dueAt ?? null,
        ...(alertCleared ? { staleAlertedAt: null } : {}),
      },
    });
  }

  /** SCOPE-03: unseen = 404. */
  private async requireVisible(
    id: string,
    actor: Principal,
  ): Promise<VisibleOpportunity> {
    const found = (await this.opportunities.findFirst({
      where: {
        id,
        AND: [visibleSalesWhere(salesAccessSubject(actor))],
      },
      select: {
        id: true,
        opportunityCode: true,
        stage: true,
        customerId: true,
      },
    })) as VisibleOpportunity | null;

    if (!found) throw new AppError('NOT_FOUND', 'ไม่พบโอกาสการขายที่ระบุ');
    return found;
  }

  private async requireOpen(id: string, actor: Principal) {
    const found = await this.requireVisible(id, actor);
    if (found.stage === 'won' || found.stage === 'lost') {
      throw new AppError('CONFLICT', 'โอกาสการขายนี้ปิดแล้ว — ลงกิจกรรมไม่ได้');
    }
    return found;
  }

  private async displayNames(ids: (string | null)[]) {
    const unique = [...new Set(ids.filter(Boolean))] as string[];
    if (!unique.length) return new Map<string, string>();

    const users = (await this.members.findMany({
      where: { id: { in: unique } },
      select: { id: true, displayName: true },
    })) as { id: string; displayName: string }[];

    return new Map(users.map((user) => [user.id, user.displayName]));
  }
}
