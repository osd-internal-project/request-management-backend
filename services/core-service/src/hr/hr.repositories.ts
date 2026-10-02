import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  TQueryClient,
} from '@request-management/share';

/** CD-207 — HR's levels, work types and labour cost rates. */

@Injectable()
export class HrLevelRepository extends BaseRepository<
  PrismaService['hrLevel']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.hrLevel;
  }
}

@Injectable()
export class HrWorkTypeRepository extends BaseRepository<
  PrismaService['hrWorkType']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.hrWorkType;
  }
}

@Injectable()
export class HrLaborRateRepository extends BaseRepository<
  PrismaService['hrLaborRate']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.hrLaborRate;
  }
}

/** CD-229 — HR's profile of a person in one company. */
@Injectable()
export class HrEmployeeRepository extends BaseRepository<
  PrismaService['hrEmployee']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.hrEmployee;
  }
}

/** CD-229 — the skill catalog, shared by every company. */
@Injectable()
export class HrSkillRepository extends BaseRepository<
  PrismaService['hrSkill']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.hrSkill;
  }
}

/** CD-229 — a person's skills. */
@Injectable()
export class HrUserSkillRepository extends BaseRepository<
  PrismaService['hrUserSkill']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.hrUserSkill;
  }
}

/**
 * CD-229 — who works for a company: its memberships with the user directory
 * (LDAP-synced) — the register lists these, it never creates people.
 */
@Injectable()
export class HrMemberRepository extends BaseRepository<
  PrismaService['userCompany']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.userCompany;
  }
}
