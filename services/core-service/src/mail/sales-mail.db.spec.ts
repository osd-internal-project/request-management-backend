import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import type { Principal } from '@request-management/share';
import { ProductPriceRepository } from '../crm/product.repositories';
import { QuotationsService } from '../crm/quotations.service';
import {
  LeadActivityRepository,
  LeadRepository,
  OpportunityActivityRepository,
  OpportunityRepository,
} from '../crm/sales.repositories';
import { CrmEmailRepository } from './crm-email.repository';
import { MockMailClient } from './mock-mail.client';
import { SalesMailService } from './sales-mail.service';

/**
 * งานขายอัตโนมัติ — the queries the unit spec mocks, against a real engine:
 * thread lookup by conversation, the per-company duplicate check, `distinct`
 * over thread ids, the lead/deal email lists, and the standard-price check's
 * filter. Writes one Lead, its activities and its emails, and removes them.
 * Needs a migrated database with a company; skipped otherwise:
 *
 *   CORE_DB_TEST_URL=postgresql://… yarn workspace \
 *     @request-management/core-service test sales-mail.db
 */
const DB_URL = process.env.CORE_DB_TEST_URL;

(DB_URL ? describe : describe.skip)('sales mail (real Postgres)', () => {
  let prisma: PrismaClient;
  let companyId: string;
  let leadId: string;
  let actor: Principal;
  let service: SalesMailService;
  const mail = new MockMailClient('sales@osd.co.th');
  const events = { emit: jest.fn() };

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    const company = await prisma.company.findFirstOrThrow({
      select: { id: true },
    });
    companyId = company.id;
    leadId = (
      await prisma.lead.create({
        data: {
          companyId,
          name: `TEST sales-mail ${randomUUID().slice(0, 8)}`,
          email: 'customer@example.com',
          intakeData: { products: [{ product_code: 'X-1', quantity: 2 }] },
        },
      })
    ).id;
    actor = {
      userId: 'svc-test',
      activeCompanyId: companyId,
      isServiceAccount: true,
      permissions: [
        'integration.crm.lead.read.all',
        'integration.crm.sales.read.all',
      ],
      ledUnitIds: [],
      scopedUnitIds: [],
    } as unknown as Principal;
    service = new SalesMailService(
      mail,
      new CrmEmailRepository(prisma as never),
      new LeadRepository(prisma as never),
      new OpportunityRepository(prisma as never),
      new LeadActivityRepository(prisma as never),
      new OpportunityActivityRepository(prisma as never),
      {} as never,
      {} as never,
      { mode: 'mock' } as never,
      { salesEmailReceived: jest.fn() } as never,
      events as never,
      { record: jest.fn() } as never,
    );
  });

  afterAll(async () => {
    if (leadId) {
      await prisma.crmEmail.deleteMany({ where: { leadId } });
      await prisma.leadActivity.deleteMany({ where: { leadId } });
      await prisma.lead.delete({ where: { id: leadId } });
    }
    await prisma.$disconnect();
  });

  it('sends, matches the reply by thread, refuses it twice, and lists both', async () => {
    const out = await service.sendLeadIntro(
      leadId,
      { body: 'ขอบคุณครับ' },
      actor,
    );
    expect(out.status).toBe('sent');

    const known = await service.knownThreads([
      out.conversation_id!,
      out.conversation_id!,
      'not-ours',
    ]);
    expect([...known]).toEqual([out.conversation_id]);

    const reply = {
      graphMessageId: 'g-1',
      internetMessageId: `<${randomUUID()}@example.com>`,
      conversationId: out.conversation_id!,
      receivedAt: new Date(),
      from: 'customer@example.com',
      to: ['sales@osd.co.th'],
      cc: [],
      subject: 'RE: ขอบคุณ',
      text: 'สนใจครับ ขอใบเสนอราคา',
      attachments: [
        { name: 'spec.pdf', contentType: 'application/pdf', size: 10 },
      ],
    };
    const stored = await service.ingest(reply);
    expect(stored).toMatchObject({
      intent: 'interested',
      leadId,
      replyToEmailId: out.id,
    });
    expect(await service.alreadyStored(reply.internetMessageId)).toBe(true);
    expect(await service.ingest(reply)).toBeNull();
    expect(events.emit).toHaveBeenCalledTimes(1);

    const listed = await service.listForLead(leadId, actor);
    expect(listed.items.map((item) => item.direction)).toEqual(['out', 'in']);
    expect(
      await prisma.leadActivity.count({ where: { leadId, type: 'email' } }),
    ).toBe(2);

    // another company's caller sees none of it
    await expect(
      service.findOne(stored!.id, { ...actor, activeCompanyId: randomUUID() }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('the standard-price query is accepted by the engine', async () => {
    // only the price repository is reached by this check
    const quotations = Object.assign(
      Object.create(QuotationsService.prototype) as QuotationsService,
      { prices: new ProductPriceRepository(prisma as never) },
    );
    const internals = quotations as unknown as {
      allAtStandardPrice(found: unknown): Promise<boolean>;
    };
    await expect(
      internals.allAtStandardPrice({
        companyId,
        currency: 'THB',
        lines: [
          {
            priceId: randomUUID(),
            unitPrice: new Prisma.Decimal(1),
            discountPct: new Prisma.Decimal(0),
          },
        ],
      }),
    ).resolves.toBe(false);
  });
});
