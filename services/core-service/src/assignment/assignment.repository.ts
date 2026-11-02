import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  BaseRepository,
  PrismaService,
  TQueryClient,
} from '@request-management/share';

/** ตารางทีม — งานของบทบาทที่ตรงเงื่อนไขไปทีม (OrgUnit) ไหน. */
@Injectable()
export class AssignmentRuleRepository extends BaseRepository<
  PrismaService['assignmentRule']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.assignmentRule;
  }
}

/** คนรับสำรอง + ประเภทคำขอที่นับงานเปิด ต่อบทบาท. */
@Injectable()
export class AssignmentRoleSettingRepository extends BaseRepository<
  PrismaService['assignmentRoleSetting']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.assignmentRoleSetting;
  }
}

/** ประวัติการจัดคน — และคิววน. */
@Injectable()
export class AssignmentRepository extends BaseRepository<
  PrismaService['assignment']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.assignment;
  }

  /** ได้งานของบทบาทนี้ครั้งล่าสุดเมื่อไร ต่อคน. */
  async lastAssigned(companyId: string, role: string, userIds: string[]) {
    if (!userIds.length) return new Map<string, Date>();
    const rows = await this.prisma.$queryRaw<{ userId: string; at: Date }[]>`
      SELECT "userId", MAX("createdAt") AS "at" FROM "assignments"
       WHERE "companyId" = ${companyId} AND "role" = ${role}
         AND "userId" IN (${Prisma.join(userIds)})
       GROUP BY "userId"`;
    return new Map(rows.map((r) => [r.userId, r.at]));
  }
}

export interface TeamMember {
  id: string;
  email: string | null;
  displayName: string;
}

/** สถานะคำขอที่ยังเป็นงานของคนทำ (ยังไม่แจ้งเสร็จ). */
const DOING = ['submitted', 'returned', 'in_progress', 'on_hold'];

/**
 * What the picker reads from other modules: a team's people and how much open
 * work each holds. Read-only; raw counts so one query answers a whole team.
 */
@Injectable()
export class AssignmentRefsRepository extends BaseRepository<
  PrismaService['user']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.user;
  }

  /** Active people of the unit who belong to the company. */
  members(companyId: string, orgUnitId: string) {
    return this.findMany({
      where: {
        orgUnitId,
        status: 'ACTIVE',
        companies: { some: { companyId } },
      },
      select: { id: true, email: true, displayName: true },
      orderBy: { id: 'asc' },
    }) as Promise<TeamMember[]>;
  }

  person(companyId: string, userId: string) {
    return this.findFirst({
      where: {
        id: userId,
        status: 'ACTIVE',
        companies: { some: { companyId } },
      },
      select: { id: true, email: true, displayName: true },
    }) as Promise<TeamMember | null>;
  }

  managerOf(companyId: string, orgUnitId: string) {
    return this.prisma.orgUnit.findFirst({
      where: { id: orgUnitId, companyId },
      select: { managerUserId: true, name: true, active: true },
    });
  }

  /** sales — Lead ของตัวเองที่สถานะกลุ่ม open + ดีลที่ยังไม่ won/lost. */
  async salesLoad(companyId: string, userIds: string[]) {
    const rows = await this.prisma.$queryRaw<{ userId: string; n: bigint }[]>`
      SELECT "userId", SUM(n)::bigint AS n FROM (
        SELECT l."ownerUserId" AS "userId", COUNT(*) AS n FROM "leads" l
          JOIN "lead_statuses" s ON s."companyId" = l."companyId" AND s."code" = l."status"
         WHERE l."companyId" = ${companyId} AND s."kind" = 'open'
           AND l."ownerUserId" IN (${Prisma.join(userIds)})
         GROUP BY l."ownerUserId"
        UNION ALL
        SELECT o."ownerUserId", COUNT(*) FROM "opportunities" o
         WHERE o."companyId" = ${companyId} AND o."stage" NOT IN ('won', 'lost')
           AND o."ownerUserId" IN (${Prisma.join(userIds)})
         GROUP BY o."ownerUserId"
      ) t GROUP BY "userId"`;
    return counts(rows);
  }

  /** presales/pricing/legal/support — คำขอประเภทของบทบาทที่ถืออยู่และยังทำไม่เสร็จ. */
  async requestLoad(companyId: string, userIds: string[], typeCodes: string[]) {
    if (!typeCodes.length) return new Map<string, number>();
    const rows = await this.prisma.$queryRaw<{ userId: string; n: bigint }[]>`
      SELECT "assigneeUserId" AS "userId", COUNT(*) AS n FROM "requests"
       WHERE "companyId" = ${companyId}
         AND "typeCode" IN (${Prisma.join(typeCodes)})
         AND "status"::text IN (${Prisma.join(DOING)})
         AND "assigneeUserId" IN (${Prisma.join(userIds)})
       GROUP BY "assigneeUserId"`;
    return counts(rows);
  }

  /** pm — โครงการที่ยังเดินอยู่. */
  async projectLoad(companyId: string, userIds: string[]) {
    const rows = await this.prisma.$queryRaw<{ userId: string; n: bigint }[]>`
      SELECT "managerUserId" AS "userId", COUNT(*) AS n FROM "projects"
       WHERE "companyId" = ${companyId}
         AND "status"::text IN ('active', 'on_hold')
         AND "managerUserId" IN (${Prisma.join(userIds)})
       GROUP BY "managerUserId"`;
    return counts(rows);
  }
}

const counts = (rows: { userId: string; n: bigint }[]) =>
  new Map(rows.map((r) => [r.userId, Number(r.n)]));
