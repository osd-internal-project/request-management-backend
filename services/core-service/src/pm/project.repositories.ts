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

/** CD-191 คำขอปิดโครงการ. */
@Injectable()
export class ProjectCloseoutRepository extends BaseRepository<
  PrismaService['projectCloseout']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.projectCloseout;
  }
}

/** CD-191 เอกสารปิดโครงการ. */
@Injectable()
export class ProjectCloseDocumentRepository extends BaseRepository<
  PrismaService['projectCloseDocument']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.projectCloseDocument;
  }
}

/** CD-191 บทเรียนของโครงการ. */
@Injectable()
export class ProjectLessonRepository extends BaseRepository<
  PrismaService['projectLesson']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.projectLesson;
  }
}

/** CD-192 รายงานสถานะรายสัปดาห์. */
@Injectable()
export class ProjectStatusReportRepository extends BaseRepository<
  PrismaService['projectStatusReport']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.projectStatusReport;
  }
}

/** CD-221 ข้อทดสอบ. */
@Injectable()
export class ProjectTestItemRepository extends BaseRepository<
  PrismaService['projectTestItem']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.projectTestItem;
  }
}

/** CD-221 ผลการทดสอบ. */
@Injectable()
export class ProjectTestRunRepository extends BaseRepository<
  PrismaService['projectTestRun']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.projectTestRun;
  }
}

/** CD-225 รายการตรวจความพร้อมก่อนส่งมอบ. */
@Injectable()
export class ProjectReadinessItemRepository extends BaseRepository<
  PrismaService['projectReadinessItem']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.projectReadinessItem;
  }
}

/** CD-226 เอกสารสภาพจริง. */
@Injectable()
export class ProjectAsBuiltDocumentRepository extends BaseRepository<
  PrismaService['projectAsBuiltDocument']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.projectAsBuiltDocument;
  }
}

/** CD-226 จุดที่ต่างจากที่ขาย. */
@Injectable()
export class ProjectAsBuiltDeviationRepository extends BaseRepository<
  PrismaService['projectAsBuiltDeviation']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.projectAsBuiltDeviation;
  }
}

/** CD-189 รอบตรวจรับ. */
@Injectable()
export class ProjectAcceptanceRepository extends BaseRepository<
  PrismaService['projectAcceptance']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.projectAcceptance;
  }
}

/** CD-189 รายการค้างจากการตรวจรับ. */
@Injectable()
export class ProjectAcceptanceItemRepository extends BaseRepository<
  PrismaService['projectAcceptanceItem']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.projectAcceptanceItem;
  }
}

/** CD-222 ประเด็นจาก UAT. */
@Injectable()
export class ProjectUatFindingRepository extends BaseRepository<
  PrismaService['projectUatFinding']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.projectUatFinding;
  }
}

/** CD-216 จุดติดตั้ง. */
@Injectable()
export class ProjectInstallationRepository extends BaseRepository<
  PrismaService['projectInstallation']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.projectInstallation;
  }
}

/** CD-211 แบบรายละเอียด. */
@Injectable()
export class ProjectDesignRepository extends BaseRepository<
  PrismaService['projectDesign']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.projectDesign;
  }
}

/** CD-211 ไฟล์แบบ. */
@Injectable()
export class ProjectDesignFileRepository extends BaseRepository<
  PrismaService['projectDesignFile']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.projectDesignFile;
  }
}

/** CD-209 อุปกรณ์และเครื่องมือของงาน. */
@Injectable()
export class ProjectTaskEquipmentRepository extends BaseRepository<
  PrismaService['projectTaskEquipment']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.projectTaskEquipment;
  }
}

/** CD-210 สำรวจหน้างาน. */
@Injectable()
export class ProjectSurveyRepository extends BaseRepository<
  PrismaService['projectSurvey']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.projectSurvey;
  }
}

@Injectable()
export class ProjectSurveyPhotoRepository extends BaseRepository<
  PrismaService['projectSurveyPhoto']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.projectSurveyPhoto;
  }
}

/** CD-213 ข้อบกพร่องงานพัฒนา. */
@Injectable()
export class ProjectDefectRepository extends BaseRepository<
  PrismaService['projectDefect']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.projectDefect;
  }
}

/** CD-214. */
@Injectable()
export class ProjectEnvironmentRepository extends BaseRepository<
  PrismaService['projectEnvironment']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.projectEnvironment;
  }
}

/** CD-214. */
@Injectable()
export class ProjectReleaseRepository extends BaseRepository<
  PrismaService['projectRelease']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.projectRelease;
  }
}

/** CD-214. */
@Injectable()
export class ProjectDeploymentRepository extends BaseRepository<
  PrismaService['projectDeployment']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.projectDeployment;
  }
}

/** CD-215. */
@Injectable()
export class ProjectSoftwareDocumentRepository extends BaseRepository<
  PrismaService['projectSoftwareDocument']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.projectSoftwareDocument;
  }
}

/** CD-217. */
@Injectable()
export class ProjectConfigItemRepository extends BaseRepository<
  PrismaService['projectConfigItem']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.projectConfigItem;
  }
}

/** CD-217. */
@Injectable()
export class ProjectConfigHistoryRepository extends BaseRepository<
  PrismaService['projectConfigHistory']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.projectConfigHistory;
  }
}

/** CD-219. */
@Injectable()
export class ProjectIntegrationRepository extends BaseRepository<
  PrismaService['projectIntegration']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.projectIntegration;
  }
}

/** CD-224. */
@Injectable()
export class ProjectTechChangeRepository extends BaseRepository<
  PrismaService['projectTechChange']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.projectTechChange;
  }
}

/** CD-190. */
@Injectable()
export class ProjectCostRepository extends BaseRepository<
  PrismaService['projectCost']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.projectCost;
  }
}

/** CD-190. */
@Injectable()
export class ProjectCostAlertRepository extends BaseRepository<
  PrismaService['projectCostAlert']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.projectCostAlert;
  }
}

/** CD-180. */
@Injectable()
export class ProjectBookingPriorityRepository extends BaseRepository<
  PrismaService['projectBookingPriority']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.projectBookingPriority;
  }
}

/** CD-180. */
@Injectable()
export class ProjectResourceRequestRepository extends BaseRepository<
  PrismaService['projectResourceRequest']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.projectResourceRequest;
  }
}
