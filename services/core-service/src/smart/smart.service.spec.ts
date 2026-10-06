import type { Principal } from '@request-management/share';
import { MockSmartConnector } from './smart-connector';
import { SmartIngestService, type SourceRow } from './smart-ingest.service';
import { SmartSweepService } from './smart-sweep.service';
import { SmartService } from './smart.service';

const actor = {
  userId: 'u-ops',
  activeCompanyId: 'osd',
  permissions: ['smart.prospect.manage'],
} as unknown as Principal;

const source = (overrides: Partial<SourceRow> = {}): SourceRow => ({
  id: 'src-1',
  companyId: 'osd',
  code: 'DBD-EAST',
  name: 'DBD ตะวันออก',
  kind: 'dbd',
  salesAxis: null,
  criteria: { keywords: ['โรงงาน'], maxResults: 3 },
  intervalHours: 24,
  active: true,
  lastRunAt: null,
  ...overrides,
});

function harness(
  options: {
    heldRefs?: string[];
    heldTax?: string[];
    found?: SourceRow | null;
  } = {},
) {
  const sources = {
    findFirst: jest.fn(() =>
      Promise.resolve(options.found === undefined ? source() : options.found),
    ),
    findMany: jest.fn(() => Promise.resolve([source()])),
    update: jest.fn(() => Promise.resolve({})),
    create: jest.fn(() => Promise.resolve(source())),
  };
  const runs = {
    create: jest.fn(() => Promise.resolve({ id: 'run-1' })),
    update: jest.fn(() => Promise.resolve({})),
  };
  const prospects = {
    findMany: jest.fn((args: { where: Record<string, unknown> }) =>
      Promise.resolve(
        'externalRef' in args.where
          ? (options.heldRefs ?? []).map((externalRef) => ({ externalRef }))
          : (options.heldTax ?? []).map((taxId) => ({ taxId })),
      ),
    ),
    createMany: jest.fn((args: { data: unknown[] }) =>
      Promise.resolve({ count: args.data.length }),
    ),
    findFirst: jest.fn(() =>
      Promise.resolve({ id: 'p-1', status: 'new', registeredCapital: null }),
    ),
    update: jest.fn(() =>
      Promise.resolve({
        id: 'p-1',
        status: 'discarded',
        registeredCapital: null,
      }),
    ),
  };
  const screening = { screenRun: jest.fn(() => Promise.resolve(0)) };
  const ingest = new SmartIngestService(
    sources as never,
    runs as never,
    prospects as never,
    screening as never,
  );
  const sweep = new SmartSweepService(
    sources as never,
    ingest,
    { get: () => 0 } as never,
    new Map([['dbd', new MockSmartConnector('dbd')]]),
  );
  const audit = { record: jest.fn(() => Promise.resolve()) };
  const service = new SmartService(
    sources as never,
    runs as never,
    prospects as never,
    ingest,
    sweep,
    audit as never,
    { execute: jest.fn((fn: (p: unknown) => unknown) => fn({})) } as never,
  );
  return { ingest, sweep, service, sources, runs, prospects, audit, screening };
}

describe('CD-289 AI SMART — sweeping into the staging list', () => {
  it('keeps new rows, counts the held and the unusable, and records the run', async () => {
    const h = harness({ heldRefs: ['ref-held'], heldTax: ['0105551234567'] });
    const outcome = await h.ingest.ingest(
      source({ kind: 'file' }),
      [
        { externalRef: 'ref-new', name: 'บริษัท ใหม่ จำกัด' },
        { externalRef: 'ref-held', name: 'บริษัท เก่า จำกัด' },
        { name: 'บริษัท ซ้ำเลข จำกัด', taxId: '0105551234567' },
        { externalRef: 'ref-new', name: 'บริษัท ใหม่ จำกัด (ซ้ำในไฟล์)' },
        { name: '' },
      ],
      'file',
      'u-ops',
    );
    expect(outcome).toMatchObject({
      found: 5,
      added: 1,
      duplicates: 3,
      rejected: 1,
      problems: [{ row: 5, reason: 'ไม่มีชื่อธุรกิจ' }],
    });
    // CD-290 — what the batch added is screened at once
    expect(h.screening.screenRun).toHaveBeenCalledWith('osd', 'run-1');
    expect(h.runs.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'ok', added: 1 }) as unknown,
      }),
    );
  });

  it('a sweep asks the connector and ingests; sweeping again finds nothing new', async () => {
    const first = harness();
    const run = await first.sweep.run(source(), 'manual', 'u-ops');
    expect(run).toMatchObject({ found: 3, added: 3 });
    const refs = (
      first.prospects.createMany.mock.calls[0] as unknown as [
        { data: { externalRef: string }[] },
      ]
    )[0].data.map((row) => row.externalRef);
    const again = harness({ heldRefs: refs });
    await expect(
      again.sweep.run(source(), 'manual', 'u-ops'),
    ).resolves.toMatchObject({ added: 0, duplicates: 3 });
  });

  it('pushed and imported sources are never swept; a push needs a push source', async () => {
    const h = harness();
    await expect(
      h.sweep.run(source({ kind: 'push' }), 'manual', null),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(h.ingest.push('osd', 'DBD-EAST', [])).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    const unknown = harness({ found: null });
    await expect(unknown.ingest.push('osd', 'NOPE', [])).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('only a file source takes an import', async () => {
    const h = harness();
    await expect(
      h.service.importRows(actor, 'src-1', [{ name: 'x' }]),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('only due sources are swept on the timer', async () => {
    const h = harness();
    h.sources.findMany.mockResolvedValueOnce([
      source(),
      source({ id: 'src-2', lastRunAt: new Date() }),
    ]);
    await expect(h.sweep.sweepDue()).resolves.toEqual({ swept: 1 });
  });

  it('a discard is audited with its reason; another company’s row is 404', async () => {
    const h = harness();
    await h.service.discard(actor, 'p-1', { reason: 'ไม่ใช่กลุ่มเป้าหมาย' });
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'smart.prospect.discarded',
        after: { status: 'discarded', reason: 'ไม่ใช่กลุ่มเป้าหมาย' },
      }),
      expect.anything(),
    );
    h.prospects.findFirst.mockResolvedValueOnce(null as never);
    await expect(h.service.prospect(actor, 'p-x')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
