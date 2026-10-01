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

/** CD-181 รายงานความคืบหน้าของงาน. */
@Injectable()
export class ProjectTaskUpdateRepository extends BaseRepository<
  PrismaService['projectTaskUpdate']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.projectTaskUpdate;
  }
}

/** CD-181 ไฟล์และรูปของงาน. */
@Injectable()
export class ProjectTaskFileRepository extends BaseRepository<
  PrismaService['projectTaskFile']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.projectTaskFile;
  }
}

/** CD-188 ความคืบหน้าที่รายงาน. */
@Injectable()
export class ProjectProgressRepository extends BaseRepository<
  PrismaService['projectProgressReport']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.projectProgressReport;
  }
}

/** CD-179 งบอ้างอิง. */
@Injectable()
export class ProjectBudgetRepository extends BaseRepository<
  PrismaService['projectBudget']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.projectBudget;
  }
}

/** CD-185 คำขอเปลี่ยนแปลง. */
@Injectable()
export class ProjectChangeRequestRepository extends BaseRepository<
  PrismaService['projectChangeRequest']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.projectChangeRequest;
  }
}

/** CD-183 ความเสี่ยงโครงการ. */
@Injectable()
export class ProjectRiskRepository extends BaseRepository<
  PrismaService['projectRisk']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.projectRisk;
  }
}

/** CD-183 การทบทวนความเสี่ยง. */
@Injectable()
export class ProjectRiskReviewRepository extends BaseRepository<
  PrismaService['projectRiskReview']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.projectRiskReview;
  }
}

/** CD-184 ปัญหาระหว่างทาง. */
@Injectable()
export class ProjectIssueRepository extends BaseRepository<
  PrismaService['projectIssue']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.projectIssue;
  }
}

/** CD-186 การประสานงานลูกค้า. */
@Injectable()
export class ProjectCustomerLogRepository extends BaseRepository<
  PrismaService['projectCustomerLog']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.projectCustomerLog;
  }
}

/** CD-193 การวางบิลและรับเงินของแต่ละงวด. */
@Injectable()
export class InstallmentBillingRepository extends BaseRepository<
  PrismaService['contractInstallmentBilling']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.contractInstallmentBilling;
  }
}
