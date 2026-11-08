import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { Readable } from 'node:stream';
import type { Principal } from '@request-management/share';
import { SendLeadEmailDto } from '../mail/dto/sales-mail.dto';
import { LeadFilesService, MAX_LEAD_FILE_BYTES } from './lead-files.service';

const person = {
  userId: 'u-sales',
  username: 'sales',
  isServiceAccount: false,
  activeCompanyId: 'co-1',
  permissions: ['crm.lead.manage', 'crm.lead.read'],
  ledUnitIds: [],
  scopedUnitIds: [],
} as unknown as Principal;

const agent = {
  ...person,
  userId: 'svc-1',
  username: 'vuvagent',
  isServiceAccount: true,
  permissions: ['integration.crm.lead.read.all', 'integration.crm.lead.update'],
} as unknown as Principal;

const pdf = (size = 3) => ({
  originalname: 'Proposal กขค.pdf',
  mimetype: 'application/pdf',
  size,
  buffer: Buffer.from('ABC'),
});

function harness(lead: object | null = { id: 'lead-1', companyId: 'co-1' }) {
  const stored = new Map<string, Buffer>();
  const rows: Record<string, unknown>[] = [];
  const leads = { findFirst: jest.fn(() => Promise.resolve(lead)) };
  const files = {
    create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
      const row = { uploadedAt: new Date('2026-11-06T03:00:00Z'), ...data };
      rows.push(row);
      return Promise.resolve(row);
    }),
    findMany: jest.fn(() => Promise.resolve(rows)),
    findFirst: jest.fn(() => Promise.resolve(rows[rows.length - 1] ?? null)),
    update: jest.fn(() => Promise.resolve({})),
  };
  const audit = { record: jest.fn() };
  const transactions = {
    execute: jest.fn((work: (prisma: unknown) => unknown) => work({})),
  };
  const storage = {
    put: jest.fn((key: string, body: Buffer) => {
      stored.set(key, body);
      return Promise.resolve();
    }),
    get: jest.fn((key: string) =>
      Promise.resolve(Readable.from([stored.get(key) ?? Buffer.alloc(0)])),
    ),
    remove: jest.fn(() => Promise.resolve()),
  };
  const service = new LeadFilesService(
    leads as never,
    files as never,
    audit as never,
    transactions as never,
    storage,
  );
  return { service, leads, files, audit, storage, rows, stored };
}

describe('LeadFilesService — files on a Lead (6 พ.ย. 2569)', () => {
  it('Vuvagent puts a proposal: bytes first, then the row, source agent', async () => {
    const h = harness();
    const view = await h.service.upload('lead-1', 'proposal', pdf(), agent);
    expect(h.storage.put).toHaveBeenCalledTimes(1);
    const key = h.storage.put.mock.calls[0][0];
    expect(key).toMatch(
      /^leads\/lead-1\/files\/[0-9a-f-]+\/Proposal กขค\.pdf$/,
    );
    expect(view).toMatchObject({
      lead_id: 'lead-1',
      kind: 'proposal',
      file_name: 'Proposal กขค.pdf',
      source: 'agent',
      uploaded_by: null,
    });
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'crm.lead.file_added' }),
      expect.anything(),
    );
  });

  it('kind defaults to other; anything else is refused', async () => {
    const h = harness();
    await expect(
      h.service.upload('lead-1', undefined, pdf(), person),
    ).resolves.toMatchObject({ kind: 'other', source: 'user' });
    await expect(
      h.service.upload('lead-1', 'contract', pdf(), person),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: [{ field: 'kind', reason: 'contract' }],
    });
  });

  it('refuses a missing file, a program, or one over 20 MB before storing', async () => {
    const h = harness();
    await expect(
      h.service.upload('lead-1', 'proposal', undefined, person),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      h.service.upload(
        'lead-1',
        'proposal',
        { ...pdf(), mimetype: 'application/x-msdownload' },
        person,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      h.service.upload(
        'lead-1',
        'proposal',
        pdf(MAX_LEAD_FILE_BYTES + 1),
        person,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(h.storage.put).not.toHaveBeenCalled();
  });

  it('a Lead out of reach (another company, not yours) is 404 and nothing is stored', async () => {
    const h = harness(null);
    await expect(
      h.service.upload('lead-x', 'proposal', pdf(), person),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(h.service.list('lead-x', person)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(h.storage.put).not.toHaveBeenCalled();
  });

  it('a row that fails to write takes its bytes with it', async () => {
    const h = harness();
    h.files.create.mockRejectedValueOnce(new Error('db down'));
    await expect(
      h.service.upload('lead-1', 'proposal', pdf(), person),
    ).rejects.toThrow('db down');
    expect(h.storage.remove).toHaveBeenCalledWith(
      h.storage.put.mock.calls[0][0],
    );
  });

  it('latestProposal reads the newest proposal whole; none = null', async () => {
    const empty = harness();
    await expect(empty.service.latestProposal('lead-1')).resolves.toBeNull();

    const h = harness();
    await h.service.upload('lead-1', 'proposal', pdf(), agent);
    const found = await h.service.latestProposal('lead-1');
    expect(h.files.findFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { leadId: 'lead-1', kind: 'proposal', deletedAt: null },
        orderBy: { uploadedAt: 'desc' },
      }),
    );
    expect(found).toMatchObject({
      fileName: 'Proposal กขค.pdf',
      mimeType: 'application/pdf',
    });
    expect(found?.content.toString()).toBe('ABC');
  });

  it('removing is a soft delete, audited', async () => {
    const h = harness();
    const view = await h.service.upload('lead-1', 'proposal', pdf(), person);
    await h.service.remove('lead-1', view.id, person);
    expect(h.files.update).toHaveBeenCalledWith(
      {
        where: { id: view.id },
        data: expect.objectContaining({ deletedBy: 'u-sales' }) as unknown,
      },
      expect.anything(),
    );
    expect(h.audit.record).toHaveBeenLastCalledWith(
      expect.objectContaining({ eventType: 'crm.lead.file_removed' }),
      expect.anything(),
    );
  });
});

describe('SendLeadEmailDto.attach_proposal — what a workflow template sends', () => {
  it.each([
    [true, true],
    ['true', true],
    ['false', false],
    ['', false],
  ])('%p → %p', (value, expected) => {
    const dto = plainToInstance(SendLeadEmailDto, {
      body: 'x',
      attach_proposal: value,
    });
    expect(validateSync(dto)).toHaveLength(0);
    expect(dto.attach_proposal).toBe(expected);
  });

  it('anything else is refused', () => {
    const dto = plainToInstance(SendLeadEmailDto, {
      body: 'x',
      attach_proposal: 'yes',
    });
    expect(validateSync(dto).map((e) => e.property)).toEqual([
      'attach_proposal',
    ]);
  });
});
