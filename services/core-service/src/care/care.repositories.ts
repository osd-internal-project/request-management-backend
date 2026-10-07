import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  type TQueryClient,
} from '@request-management/share';

/** CD-280 — conversations with customers. */
@Injectable()
export class CareConversationRepository extends BaseRepository<
  PrismaService['careConversation']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.careConversation;
  }
}

/** CD-280 — their messages. */
@Injectable()
export class CareMessageRepository extends BaseRepository<
  PrismaService['careMessage']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.careMessage;
  }

  /** Clear texts older than `before` in closed conversations. */
  async purge(before: Date) {
    const cleared = await this.prisma.$executeRawUnsafe(
      `UPDATE care_messages m SET text = NULL
       FROM care_conversations c
       WHERE c.id = m."conversationId" AND c.status = 'closed'
         AND m."createdAt" < $1 AND m.text IS NOT NULL`,
      before,
    );
    await this.prisma.$executeRawUnsafe(
      `UPDATE care_conversations SET "textPurgedAt" = now()
       WHERE status = 'closed' AND "textPurgedAt" IS NULL AND "lastMessageAt" < $1`,
      before,
    );
    return cleared;
  }
}

/** CD-280 — channel identities confirmed to be a contact. */
@Injectable()
export class CareIdentityRepository extends BaseRepository<
  PrismaService['careIdentity']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.careIdentity;
  }
}

export interface ContactMatch {
  id: string;
  customerId: string;
  name: string;
}

/**
 * CD-280 — active contacts of a company's customers by LINE id, email or
 * phone (phones compared on their last 9 digits, whatever the formatting).
 */
@Injectable()
export class CareContactLookupRepository {
  constructor(private readonly prisma: PrismaService) {}

  byField(
    companyId: string,
    field: 'lineId' | 'email' | 'phone',
    values: string[],
  ) {
    if (!values.length) return Promise.resolve([] as ContactMatch[]);
    const column =
      field === 'phone'
        ? `right(regexp_replace(c.phone, '\\D', '', 'g'), 9)`
        : field === 'email'
          ? `lower(trim(c.email))`
          : `c."lineId"`;
    return this.prisma.$queryRawUnsafe<ContactMatch[]>(
      `SELECT c.id, c."customerId", c.name
       FROM customer_contacts c JOIN customers cu ON cu.id = c."customerId"
       WHERE cu."companyId" = $1 AND c.active AND ${column} = ANY($2::text[])
       ORDER BY c."isPrimary" DESC, c."createdAt"`,
      companyId,
      values,
    );
  }

  customersByCode(companyId: string, codes: string[]) {
    if (!codes.length) return Promise.resolve([] as { id: string }[]);
    return this.prisma.customer.findMany({
      where: { companyId, customerCode: { in: codes } },
      select: { id: true },
    });
  }

  customer(id: string) {
    return this.prisma.customer.findUnique({
      where: { id },
      select: { id: true, customerCode: true, nameTh: true, companyId: true },
    });
  }

  contact(id: string) {
    return this.prisma.customerContact.findFirst({
      where: { id, active: true },
      select: { id: true, customerId: true, name: true },
    });
  }

  contactDetail(id: string) {
    return this.prisma.customerContact.findFirst({
      where: { id },
      select: { id: true, name: true, phone: true, email: true },
    });
  }

  contacts(customerId: string) {
    return this.prisma.customerContact.findMany({
      where: { customerId, active: true },
      orderBy: [{ isPrimary: 'desc' }, { name: 'asc' }],
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        lineId: true,
        isPrimary: true,
      },
    });
  }
}

/** CD-283 — who in a company may take a conversation over. */
@Injectable()
export class CareStaffRepository {
  constructor(private readonly prisma: PrismaService) {}

  holdersOf(companyId: string, permission: string) {
    return this.prisma.userRole
      .findMany({
        where: {
          companyId,
          role: {
            active: true,
            permissions: { some: { permissionCode: permission } },
          },
          user: { status: 'ACTIVE' },
        },
        select: { userId: true },
      })
      .then((rows) => [...new Set(rows.map((row) => row.userId))]);
  }
}
