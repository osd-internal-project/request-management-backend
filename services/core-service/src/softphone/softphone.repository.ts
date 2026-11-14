import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  TQueryClient,
} from '@request-management/share';

/** The request type a softphone call is logged as (seeded per company). */
export const CALL_LOG_TYPE = 'CALL_LOG';

/** Every `softphone_extensions` query, and the call-log lookups beside it. */
@Injectable()
export class SoftphoneExtensionRepository extends BaseRepository<
  PrismaService['softphoneExtension']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.softphoneExtension;
  }

  /** Every extension of the company, inactive included — the admin list. */
  findForCompany(companyId: string) {
    return this.prisma.softphoneExtension.findMany({
      where: { companyId },
      orderBy: { extension: 'asc' },
    });
  }

  /** Names for the admin list; extensions keep a plain `userId`. */
  async usersByIds(
    ids: readonly string[],
  ): Promise<{ id: string; username: string; displayName: string }[]> {
    if (!ids.length) return [];
    return this.prisma.user.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, username: true, displayName: true },
    });
  }

  /** Whether the user belongs to the company — a line goes to members only. */
  async isMember(companyId: string, userId: string): Promise<boolean> {
    const row = await this.prisma.userCompany.findFirst({
      where: { companyId, userId },
      select: { id: true },
    });
    return row !== null;
  }

  /** Same test as `RequestsService.requireType`, asked first for a clear error. */
  async callLogTypeEnabled(companyId: string): Promise<boolean> {
    const row = await this.prisma.requestType.findFirst({
      where: {
        code: CALL_LOG_TYPE,
        active: true,
        companies: { some: { companyId, active: true } },
      },
      select: { id: true },
    });
    return row !== null;
  }

  /** The call log already written for this call, if any. */
  findCallLog(companyId: string, callId: string) {
    return this.prisma.request.findFirst({
      where: {
        companyId,
        typeCode: CALL_LOG_TYPE,
        formData: { path: ['call_id'], equals: callId },
      },
      select: { id: true },
    });
  }
}
