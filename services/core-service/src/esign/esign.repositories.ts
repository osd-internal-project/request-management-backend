import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  type TQueryClient,
} from '@request-management/share';

/** CD-165 ช่องลงนามต่อประเภทเอกสาร. */
@Injectable()
export class EsignLayoutRepository extends BaseRepository<
  PrismaService['esignLayout']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.esignLayout;
  }
}

/** CD-166 เอกสารที่ส่งลงนาม. */
@Injectable()
export class EsignEnvelopeRepository extends BaseRepository<
  PrismaService['esignEnvelope']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.esignEnvelope;
  }
}

/** CD-166..168 ผู้ลงนาม. */
@Injectable()
export class EsignSignerRepository extends BaseRepository<
  PrismaService['esignSigner']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.esignSigner;
  }
}

/** CD-170 ประวัติการลงนาม — เขียนแล้วไม่แก้. */
@Injectable()
export class EsignEventRepository extends BaseRepository<
  PrismaService['esignEvent']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.esignEvent;
  }
}

/** CD-172 ทะเบียนผู้มีอำนาจลงนาม. */
@Injectable()
export class EsignAuthorityRepository extends BaseRepository<
  PrismaService['esignAuthority']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.esignAuthority;
  }
}
