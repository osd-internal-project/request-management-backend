import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  TQueryClient,
} from '@request-management/share';

/** Who `line-recipients` asks about: the email a caller knows, or the id an approval step names. */
export type LineRecipientKey = { email: string } | { userId: string };

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

  /** An active member of the company by exact email or id, with their LINE there if linked. */
  member(companyId: string, by: LineRecipientKey) {
    return this.prisma.user.findFirst({
      where: {
        ...('email' in by ? { email: by.email } : { id: by.userId }),
        status: 'ACTIVE',
        companies: { some: { companyId } },
      },
      select: {
        id: true,
        email: true,
        displayName: true,
        lineAccounts: { where: { companyId } },
      },
    });
  }
}
