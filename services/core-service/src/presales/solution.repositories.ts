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

/** CD-140 คำถาม-คำตอบทางเทคนิคกับลูกค้า. */
@Injectable()
export class SolutionClarificationRepository extends BaseRepository<
  PrismaService['solutionClarification']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.solutionClarification;
  }
}

/** CD-141 ทะเบียนความเสี่ยงทางเทคนิค. */
@Injectable()
export class SolutionRiskRepository extends BaseRepository<
  PrismaService['solutionRisk']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.solutionRisk;
  }
}

/** CD-139 Demo / POC ของ Solution. */
@Injectable()
export class SolutionDemoRepository extends BaseRepository<
  PrismaService['solutionDemo']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.solutionDemo;
  }
}

/** CD-139 อุปกรณ์ที่เบิกไปใช้ใน Demo/POC. */
@Injectable()
export class SolutionDemoEquipmentRepository extends BaseRepository<
  PrismaService['solutionDemoEquipment']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.solutionDemoEquipment;
  }
}

/** CD-139 ข้อค้นพบจาก Demo/POC. */
@Injectable()
export class SolutionDemoFindingRepository extends BaseRepository<
  PrismaService['solutionDemoFinding']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.solutionDemoFinding;
  }
}

/** CD-138 ข้อมูลหลักของ TOR / RFP. */
@Injectable()
export class SolutionTorRepository extends BaseRepository<
  PrismaService['solutionTor']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.solutionTor;
  }
}

/** CD-138 ไฟล์ TOR / RFP ต้นฉบับ. */
@Injectable()
export class SolutionTorFileRepository extends BaseRepository<
  PrismaService['solutionTorFile']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.solutionTorFile;
  }
}

/** CD-138 ข้อกำหนดของ TOR รายข้อ. */
@Injectable()
export class SolutionTorClauseRepository extends BaseRepository<
  PrismaService['solutionTorClause']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.solutionTorClause;
  }
}

/** CD-136 ใบเสนอราคาจากคู่ค้า. */
@Injectable()
export class SolutionPartnerQuoteRepository extends BaseRepository<
  PrismaService['solutionPartnerQuote']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.solutionPartnerQuote;
  }
}
