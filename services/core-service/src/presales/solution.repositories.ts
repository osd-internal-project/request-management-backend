import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  type TQueryClient,
} from '@request-management/share';

/** CD-132 Solution ของดีล — หนึ่งต่อคำขอ "ขอ Solution". */
@Injectable()
export class SolutionRepository extends BaseRepository<
  PrismaService['solution']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.solution;
  }
}

/** CD-132 เวอร์ชันของ Solution — ร่างแก้ได้ ยืนยันแล้วแก้ไม่ได้. */
@Injectable()
export class SolutionVersionRepository extends BaseRepository<
  PrismaService['solutionVersion']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.solutionVersion;
  }
}

/** CD-132 ไฟล์แบบของเวอร์ชัน. */
@Injectable()
export class SolutionFileRepository extends BaseRepository<
  PrismaService['solutionFile']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.solutionFile;
  }
}

/** CD-131 ความต้องการที่วิเคราะห์แล้วของ Solution. */
@Injectable()
export class SolutionRequirementRepository extends BaseRepository<
  PrismaService['solutionRequirement']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.solutionRequirement;
  }
}
