import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  TQueryClient,
} from '@request-management/share';

/** A user's LINE per company; unlinking deletes the row (the audit log keeps the event). */
@Injectable()
export class UserLineAccountRepository extends BaseRepository<
  PrismaService['userLineAccount']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.userLineAccount;
  }

  /** An active member of the company by exact email, with their LINE there if linked. */
  member(companyId: string, email: string) {
    return this.prisma.user.findFirst({
      where: { email, status: 'ACTIVE', companies: { some: { companyId } } },
      select: {
        id: true,
        email: true,
        displayName: true,
        lineAccounts: { where: { companyId } },
      },
    });
  }
}
