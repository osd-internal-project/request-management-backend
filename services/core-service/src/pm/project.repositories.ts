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
