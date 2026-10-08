import { KbIssueService } from './kb-issue.service';
import { articleFromIssue, productCodesOf } from './kb-field-rules';

describe('CD-223 technical issues into the knowledge base — the draft', () => {
  it('symptom, cause and fix, from the project, without empty sections', () => {
    const article = articleFromIssue({
      projectNo: 'PRJ-7',
      seq: 3,
      title: ' กล้องหลุดจาก NVR ',
      description: 'ภาพดับทุก 2 ชั่วโมง',
      cause: 'DHCP lease หมดอายุ',
      resolution: 'ตั้ง IP คงที่',
    });
    expect(article).toEqual({
      title: 'กล้องหลุดจาก NVR',
      sourceRef: 'PRJ-7/I-3',
      body: [
        '> แก้ปัญหาทางเทคนิคระหว่างโครงการ PRJ-7/I-3',
        '',
        '## อาการที่พบ',
        'ภาพดับทุก 2 ชั่วโมง',
        '',
        '## สาเหตุ',
        'DHCP lease หมดอายุ',
        '',
        '## วิธีแก้',
        'ตั้ง IP คงที่',
      ].join('\n'),
    });
  });

  it('tags with the products sold, each once', () => {
    expect(
      productCodesOf({
        boq: [
          { productCode: 'CAM-01' },
          { productCode: 'CAM-01' },
          { productCode: ' ' },
          {},
          { productCode: 'NVR-2' },
        ],
      }),
    ).toEqual(['CAM-01', 'NVR-2']);
    expect(productCodesOf(null)).toEqual([]);
  });
});

function harness(kbmsStatus: string | null = 'pending') {
  const issue = {
    id: 'i-1',
    companyId: 'osd',
    projectId: 'p-1',
    seq: 3,
    title: 'กล้องหลุด',
    description: 'ภาพดับ',
    cause: 'DHCP',
    resolution: 'IP คงที่',
    resolvedBy: 'u-eng',
    ownerUserId: 'u-owner',
    kbmsStatus,
  };
  const issues = {
    findFirst: jest.fn(() => Promise.resolve({ ...issue })),
    findMany: jest.fn(() => Promise.resolve([{ id: 'i-1' }])),
    updateMany: jest.fn(
      (args: {
        where: { kbmsStatus: string };
        data: { kbmsStatus: string };
      }) => {
        if (issue.kbmsStatus !== args.where.kbmsStatus) {
          return Promise.resolve({ count: 0 });
        }
        issue.kbmsStatus = args.data.kbmsStatus;
        return Promise.resolve({ count: 1 });
      },
    ),
    update: jest.fn((args: { data: Record<string, unknown> }) => {
      Object.assign(issue, args.data);
      return Promise.resolve({});
    }),
  };
  const projects = {
    findFirst: jest.fn(() =>
      Promise.resolve({
        projectNo: 'PRJ-7',
        baseline: { boq: [{ productCode: 'CAM-01' }] },
      }),
    ),
  };
  const kb = {
    insertDraft: jest.fn(() =>
      Promise.resolve({ id: 'a-1', articleNo: 'KB-00042' }),
    ),
  };
  const review = { submitSystemDraft: jest.fn(() => Promise.resolve()) };
  const hooks = { on: jest.fn() };
  const audit = { record: jest.fn(() => Promise.resolve()) };
  const service = new KbIssueService(
    issues as never,
    projects as never,
    kb as never,
    review as never,
    hooks as never,
    audit as never,
    { get: () => 0 } as never,
  );
  return { service, issue, kb, review, hooks };
}

describe('CD-223 technical issues into the knowledge base — sending', () => {
  it('writes the draft as whoever resolved it, sends it for review, records the number', async () => {
    const h = harness();
    await expect(h.service.sendIssue('i-1')).resolves.toEqual({
      articleNo: 'KB-00042',
    });
    expect(h.kb.insertDraft).toHaveBeenCalledWith(
      'osd',
      'u-eng',
      expect.objectContaining({ title: 'กล้องหลุด', productCodes: ['CAM-01'] }),
      { source: 'project_issue', sourceRef: 'PRJ-7/I-3' },
    );
    expect(h.review.submitSystemDraft).toHaveBeenCalledWith('a-1');
    expect(h.issue).toMatchObject({ kbmsStatus: 'sent', kbmsRef: 'KB-00042' });
  });

  it('once only: a second call, or an issue not waiting, writes nothing', async () => {
    const h = harness();
    await h.service.sendIssue('i-1');
    await expect(h.service.sendIssue('i-1')).resolves.toBeNull();
    expect(h.kb.insertDraft).toHaveBeenCalledTimes(1);
    await expect(harness(null).service.sendIssue('i-1')).resolves.toBeNull();
  });

  it('a failure puts it back for the sweep', async () => {
    const h = harness();
    h.kb.insertDraft.mockRejectedValueOnce(new Error('db down'));
    await expect(h.service.sendIssue('i-1')).rejects.toThrow('db down');
    expect(h.issue.kbmsStatus).toBe('pending');
    await expect(h.service.sweep()).resolves.toEqual({ sent: 1 });
    expect(h.issue.kbmsStatus).toBe('sent');
  });

  it('subscribes to resolved issues when the module starts', () => {
    const h = harness();
    h.service.onModuleInit();
    expect(h.hooks.on).toHaveBeenCalledTimes(1);
  });
});
