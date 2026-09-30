import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { PDFDocument } from 'pdf-lib';
import { PrismaClient } from '@prisma/client';
import type { Principal } from '@request-management/share';
import { CompanyMemberRepository } from '../access/company-member.repository';
import { EsignLayoutsService } from './esign-layouts.service';
import { EsignAuthoritiesService } from './esign-authorities.service';
import { EsignService, type CreateEnvelopeInput } from './esign.service';
import {
  EsignAuthorityRepository,
  EsignEnvelopeRepository,
  EsignEventRepository,
  EsignLayoutRepository,
  EsignSignerRepository,
} from './esign.repositories';

/**
 * CD-14 — the whole signing path on a real database: a layout, an envelope
 * with an external signer (link + one-time code) and an internal one (in
 * order), the seal, and the verification page. Skipped without a database:
 *
 *   CORE_DB_TEST_URL=postgresql://… yarn workspace \
 *     @request-management/core-service test esign.db
 */
const DB_URL = process.env.CORE_DB_TEST_URL;

const PNG = `data:image/png;base64,${Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
).toString('base64')}`;

(DB_URL ? describe : describe.skip)('CD-14 e-signature (real Postgres)', () => {
  let prisma: PrismaClient;
  let companyId: string;
  let userId: string;
  const files = new Map<string, Buffer>();
  const codes: string[] = [];
  const emitted: unknown[] = [];
  const told: unknown[] = [];
  const reminded: unknown[] = [];
  const sentLinks: string[] = [];
  let layoutId = '';
  let envelopeId = '';
  const moreEnvelopes: string[] = [];

  const storage = {
    put: (key: string, body: Buffer) => {
      files.set(key, Buffer.from(body));
      return Promise.resolve();
    },
    get: (key: string) => {
      const body = files.get(key);
      if (!body) return Promise.reject(new Error(`no ${key}`));
      return Promise.resolve(Readable.from([body]));
    },
    remove: (key: string) => {
      files.delete(key);
      return Promise.resolve();
    },
  };

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    const member = await prisma.userCompany.findFirstOrThrow({
      where: { user: { status: 'ACTIVE' } },
      select: { companyId: true, userId: true },
    });
    companyId = member.companyId;
    userId = member.userId;
  });

  afterAll(async () => {
    await prisma.esignEnvelope.deleteMany({
      where: { id: { in: [envelopeId, ...moreEnvelopes].filter(Boolean) } },
    });
    if (layoutId)
      await prisma.esignLayout.deleteMany({ where: { id: layoutId } });
    await prisma.esignAuthority.deleteMany({
      where: { companyId, userId, note: 'T172' },
    });
    await prisma.$disconnect();
  });

  function build() {
    const client = prisma as never;
    const audit = { record: () => Promise.resolve() } as never;
    const layouts = new EsignLayoutsService(
      new EsignLayoutRepository(client),
      audit,
    );
    const authorities = new EsignAuthoritiesService(
      new EsignAuthorityRepository(client),
      new CompanyMemberRepository(client),
      audit,
    );
    const service = new EsignService(
      new EsignEnvelopeRepository(client),
      new EsignSignerRepository(client),
      new EsignEventRepository(client),
      layouts,
      new CompanyMemberRepository(client),
      {
        esignRequested: (...args: unknown[]) => {
          told.push(args);
          return Promise.resolve();
        },
        esignFinished: (...args: unknown[]) => {
          told.push(args);
          return Promise.resolve();
        },
        esignReminder: (...args: unknown[]) => {
          reminded.push(args);
          return Promise.resolve();
        },
      } as never,
      {
        emit: (event: unknown) => {
          emitted.push(event);
          return Promise.resolve();
        },
      } as never,
      {
        execute: (work: (tx: unknown) => Promise<unknown>) =>
          prisma.$transaction((tx) => work(tx)),
      } as never,
      audit,
      {
        get: (key: string) =>
          ({ 'esign.publicUrl': 'http://sign.test', 'esign.secret': 'test' })[
            key
          ],
      } as never,
      storage,
      {
        channels: ['email'],
        sendLink: (_: unknown, message: { link: string }) => {
          sentLinks.push(message.link);
          return Promise.resolve();
        },
        sendCode: (_: string, __: string, message: { code: string }) => {
          codes.push(message.code);
          return Promise.resolve();
        },
      } as never,
      authorities,
      {
        across: () =>
          Promise.resolve({
            of: () => ({
              enabled: true,
              params: { every_days: 2, max_reminders: 2, warn_days: 1 },
            }),
          }),
      } as never,
    );
    return { service, layouts, authorities, client };
  }

  it('an external signer by link and code, then an internal one; sealed and verifiable', async () => {
    const { service, layouts, authorities } = build();
    const actor = {
      userId,
      activeCompanyId: companyId,
      permissions: ['esign.manage'],
    } as unknown as Principal;
    const meta = { ip: '203.0.113.5', userAgent: 'jest' };

    const layout = await layouts.create(
      {
        code: `T14-${Date.now().toString(36)}`,
        name: 'สัญญาสองฝ่าย',
        fields: [
          {
            label: 'ผู้ว่าจ้าง',
            page: 'last',
            position: 'bottom-left',
            order: 1,
          },
          {
            label: 'ผู้รับจ้าง',
            page: 'appendix',
            position: 'bottom-left',
            order: 2,
            authority: true,
          },
        ],
      },
      actor,
    );
    layoutId = layout.id;

    const doc = await PDFDocument.create();
    doc.addPage([595, 842]);
    const input: CreateEnvelopeInput = {
      companyId,
      title: 'CTR-TEST · สัญญาทดสอบ',
      pdf: Buffer.from(await doc.save()),
      originalName: 'contract.pdf',
      sourceType: 'test',
      sourceId: 'doc-1',
      refType: 'test',
      refId: 'ref-1',
      layoutId: layout.id,
      amount: 500_000,
      signers: [
        {
          field_key: 'f1',
          kind: 'external',
          name: 'ลูกค้า ทดสอบ',
          email: 'Customer@Example.com',
        },
        { field_key: 'f2', kind: 'internal', user_id: userId },
      ],
    };
    // CD-172 — the company's signatory must be on the register, in the limit
    await expect(service.create(input, actor)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    const entry = await authorities.create(
      {
        user_id: userId,
        title: 'กรรมการ',
        limit_amount: 100_000,
        note: 'T172',
      },
      actor,
    );
    await expect(service.create(input, actor)).rejects.toMatchObject({
      message: expect.stringContaining('ไม่ถึงมูลค่าเอกสาร') as unknown,
    });
    await authorities.update(entry.id, { limit_amount: 1_000_000 }, actor);
    const created = await service.create(input, actor);
    envelopeId = created.id;
    expect(created.status).toBe('draft');

    const sent = await service.send(envelopeId, actor, meta);
    expect(sent.links).toHaveLength(1);
    const token = sent.links[0].link.split('/s/')[1];
    const internalId = sent.signers.find((one) => one.kind === 'internal')!.id;

    // in order: the internal signer waits for the customer
    await service.internalDocument(internalId, actor, meta);
    await expect(
      service.internalSign(
        internalId,
        { kind: 'type', text: 'x', consent: true },
        actor,
        meta,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    // the customer: the link, the code, the document, the signature
    const page = await service.publicView(token, meta);
    expect(page).toMatchObject({ role: 'ผู้ว่าจ้าง', verified: false });
    expect(page.channels).toEqual([
      { channel: 'email', to: 'cu•••@example.com' },
    ]);
    await expect(service.publicDocument(token, meta)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await service.sendCode(token, 'email', meta);
    await expect(
      service.verifyCode(
        token,
        codes[0] === '000000' ? '111111' : '000000',
        meta,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await service.verifyCode(token, codes[0], meta);
    await expect(
      service.publicSign(
        token,
        { kind: 'draw', image: PNG, consent: true },
        meta,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' }); // read it first
    await service.publicDocument(token, meta);
    await service.publicSign(
      token,
      { kind: 'draw', image: PNG, consent: true },
      meta,
    );
    await expect(
      service.publicSign(
        token,
        { kind: 'draw', image: PNG, consent: true },
        meta,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    // the internal signer is told now that it is their turn
    expect(told).toHaveLength(1);

    // taken off the register while the document waits: cannot sign

    await authorities.update(entry.id, { active: false }, actor);

    await expect(
      service.internalSign(
        internalId,

        { kind: 'type', text: 'x', consent: true },

        actor,

        meta,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    await authorities.update(entry.id, { active: true }, actor);

    await service.internalSign(
      internalId,
      { kind: 'type', text: 'ผู้รับจ้าง ทดสอบ', consent: true },
      actor,
      meta,
    );

    const done = await service.view(envelopeId, actor);
    expect(done.status).toBe('completed');
    expect(done.signers.every((one) => one.status === 'signed')).toBe(true);
    expect(emitted).toEqual([
      expect.objectContaining({ name: 'esign.completed' }),
    ]);
    const signed = await service.signedBytes(envelopeId);
    expect((await PDFDocument.load(signed)).getPageCount()).toBe(3);
    const hash = createHash('sha256').update(signed).digest('hex');
    expect(done.signedHash).toBe(hash);

    // CD-173 — the holder checks their file
    const info = await service.verifyInfo(done.verifyCode!);
    expect(info.signers.map((one) => one.role)).toEqual([
      'ผู้ว่าจ้าง',
      'ผู้รับจ้าง',
    ]);
    await expect(service.verifyHash(done.verifyCode!, hash)).resolves.toEqual({
      match: true,
    });
    await expect(
      service.verifyHash(done.verifyCode!, 'f'.repeat(64)),
    ).resolves.toEqual({ match: false });
    // the evidence
    const kinds = done.history.map((event) => event.type);
    for (const kind of [
      'sent',
      'opened',
      'otp_sent',
      'otp_failed',
      'otp_verified',
      'viewed',
      'signed',
      'sealed',
    ]) {
      expect(kinds).toContain(kind);
    }
  });

  it('CD-171: reminds in turn, warns the sender, expires; extend reopens; a reissued link replaces the old', async () => {
    const { service, layouts } = build();
    const actor = {
      userId,
      activeCompanyId: companyId,
      permissions: ['esign.manage'],
    } as unknown as Principal;
    const layout = await layouts.create(
      {
        code: `T171-${Date.now().toString(36)}`,
        name: 'สองฝ่าย (เตือนซ้ำ)',
        fields: [
          {
            label: 'ผู้ว่าจ้าง',
            page: 'last',
            position: 'bottom-left',
            order: 1,
          },
          {
            label: 'ผู้รับจ้าง',
            page: 'last',
            position: 'bottom-right',
            order: 2,
          },
        ],
      },
      actor,
    );
    const doc = await PDFDocument.create();
    doc.addPage([595, 842]);
    const created = await service.create(
      {
        companyId,
        title: 'T171 · เตือนซ้ำ',
        pdf: Buffer.from(await doc.save()),
        originalName: 'contract.pdf',
        sourceType: 'test',
        sourceId: 'doc-171',
        refType: 'test',
        refId: 'ref-171',
        layoutId: layout.id,
        expiresInDays: 5,
        signers: [
          {
            field_key: 'f1',
            kind: 'external',
            name: 'ลูกค้า',
            email: 'c@example.com',
          },
          { field_key: 'f2', kind: 'internal', user_id: userId },
        ],
      },
      actor,
    );
    moreEnvelopes.push(created.id);
    const sent = await service.send(created.id, actor, {
      ip: null,
      userAgent: null,
    });
    const link = sent.links[0].link;
    const day = 86_400_000;
    const start = Date.now();
    reminded.length = 0;
    sentLinks.length = 0;

    // a day later: nothing yet (every 2 days)
    let counts = await service.sweep(new Date(start + day));
    expect(counts.reminded).toBe(0);
    // two days later: the customer (their turn) gets the same link again;
    // the employee waits for their turn
    counts = await service.sweep(new Date(start + 2 * day + 60_000));
    expect(counts.reminded).toBe(1);
    expect(sentLinks).toEqual([link]);
    // the same tick again repeats nothing
    counts = await service.sweep(new Date(start + 2 * day + 120_000));
    expect(counts.reminded).toBe(0);

    // a day before the end: the sender is told, once — and the customer's
    // second (and last, max 2) reminder is due
    counts = await service.sweep(new Date(start + 4 * day + 60_000));
    expect(counts).toMatchObject({ warned: 1, reminded: 1 });
    counts = await service.sweep(new Date(start + 4 * day + 120_000));
    expect(counts).toMatchObject({ warned: 0, reminded: 0 });
    expect(sentLinks).toEqual([link, link]);

    // past the end: expired, the sender told
    counts = await service.sweep(new Date(start + 6 * day));
    expect(counts.expired).toBe(1);
    expect((await service.view(created.id, actor)).status).toBe('expired');
    expect(reminded.some((args) => (args as unknown[])[0] === 'expired')).toBe(
      true,
    );

    // more time: waiting again
    const extended = await service.extend(created.id, 7, actor);
    expect(extended.status).toBe('sent');

    // a new link: the old one no longer opens
    const customer = extended.signers.find((one) => one.kind === 'external')!;
    const fresh = await service.reissueLink(created.id, customer.id, actor);
    expect(fresh.link).not.toBe(link);
    await expect(
      service.publicView(link.split('/s/')[1], { ip: null, userAgent: null }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      service.publicView(fresh.link.split('/s/')[1], {
        ip: null,
        userAgent: null,
      }),
    ).resolves.toMatchObject({ role: 'ผู้ว่าจ้าง' });
    await prisma.esignLayout.deleteMany({ where: { id: layout.id } });
  });
});
