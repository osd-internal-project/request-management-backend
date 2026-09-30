import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  type TQueryClient,
} from '@request-management/share';

/** CD-175 โครงการ — one per signed contract. */
@Injectable()
export class ProjectRepository extends BaseRepository<
  PrismaService['project']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.project;
  }
}

/** CD-175 ทีมโครงการ. */
@Injectable()
export class ProjectMemberRepository extends BaseRepository<
  PrismaService['projectMember']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.projectMember;
  }
}

/** CD-182 หมุดหมายของโครงการ. */
@Injectable()
export class ProjectMilestoneRepository extends BaseRepository<
  PrismaService['projectMilestone']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.projectMilestone;
  }
}

/** CD-177 งานในแผนโครงการ. */
@Injectable()
export class ProjectTaskRepository extends BaseRepository<
  PrismaService['projectTask']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.projectTask;
  }
}

/** CD-177 ลำดับงาน (งานใดต้องเสร็จก่อนงานใด). */
@Injectable()
export class ProjectTaskLinkRepository extends BaseRepository<
  PrismaService['projectTaskLink']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.projectTaskLink;
  }
}

/**
 * CD-177 — the company's working calendar (the SLA's holiday calendar),
 * read here to date the plan.
 */
@Injectable()
export class WorkCalendarRepository extends BaseRepository<
  PrismaService['holidayCalendar']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.holidayCalendar;
  }
}
