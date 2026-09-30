import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { PDFDocument } from 'pdf-lib';
import { PrismaClient } from '@prisma/client';
import type { Principal } from '@request-management/share';
import { CompanyMemberRepository } from '../access/company-member.repository';
import { EsignLayoutsService } from './esign-layouts.service';
import { EsignService } from './esign.service';
import {
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
  let layoutId = '';
  let envelopeId = '';

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
    if (envelopeId) {
      await prisma.esignEnvelope.deleteMany({ where: { id: envelopeId } });
    }
    if (layoutId)
      await prisma.esignLayout.deleteMany({ where: { id: layoutId } });
    await prisma.$disconnect();
  });

  it('an external signer by link and code, then an internal one; sealed and verifiable', async () => {
    const client = prisma as never;
    const audit = { record: () => Promise.resolve() } as never;
    const layouts = new EsignLayoutsService(
      new EsignLayoutRepository(client),
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
        sendLink: () => Promise.resolve(),
        sendCode: (_: string, __: string, message: { code: string }) => {
          codes.push(message.code);
          return Promise.resolve();
        },
      } as never,
    );
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
          },
        ],
      },
      actor,
    );
    layoutId = layout.id;

    const doc = await PDFDocument.create();
    doc.addPage([595, 842]);
    const created = await service.create(
      {
        companyId,
        title: 'CTR-TEST · สัญญาทดสอบ',
        pdf: Buffer.from(await doc.save()),
        originalName: 'contract.pdf',
        sourceType: 'test',
        sourceId: 'doc-1',
        refType: 'test',
        refId: 'ref-1',
        layoutId: layout.id,
        signers: [
          {
            field_key: 'f1',
            kind: 'external',
            name: 'ลูกค้า ทดสอบ',
            email: 'Customer@Example.com',
          },
          { field_key: 'f2', kind: 'internal', user_id: userId },
        ],
      },
      actor,
    );
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
});
