import type { Principal } from '@request-management/share';
import { ContentApprovalService } from './content-approval.service';

const actor = {
  userId: 'u-mkt',
  activeCompanyId: 'osd',
  permissions: ['crm.campaign.manage'],
} as unknown as Principal;

const item = (overrides: Record<string, unknown> = {}) => ({
  id: 'c-1',
  companyId: 'osd',
  channel: 'facebook',
  title: 'โปรโมชันกล้อง',
  caption: 'ลด 20%',
  ownerUserId: 'u-owner',
  plannedAt: new Date('2026-10-10T03:00:00Z'),
  status: 'draft',
  version: 3,
  mentionsCustomer: false,
  mentionsPrice: true,
  mentionsPartner: false,
  approvalStatus: 'none',
  approvalRequestId: null,
  approvedVersion: null,
  ...overrides,
});

function harness(
  options: {
    found?: unknown;
    typeCode?: string | null;
    all?: boolean;
    pending?: unknown;
    submitFails?: boolean;
  } = {},
) {
  const content = {
    require: jest.fn(() =>
      Promise.resolve(options.found === undefined ? item() : options.found),
    ),
    one: jest.fn(() => Promise.resolve({ id: 'c-1' })),
  };
  const items = {
    findFirst: jest.fn(() => Promise.resolve(options.pending ?? null)),
    updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
  };
  const files = {
    findMany: jest.fn(() => Promise.resolve([{ fileName: 'banner.png' }])),
  };
  const requests = {
    create: jest.fn(() => Promise.resolve({ id: 'req-1', requestNo: 'REQ-1' })),
    submit: jest.fn(() =>
      options.submitFails
        ? Promise.reject(new Error('ไม่มีผู้อนุมัติ'))
        : Promise.resolve({}),
    ),
    cancel: jest.fn(() => Promise.resolve({})),
  };
  const configs = {
    findFirst: jest.fn(() =>
      Promise.resolve({
        contentApprovalTypeCode:
          options.typeCode === undefined ? 'CNA' : options.typeCode,
        contentApprovalAll: options.all ?? false,
      }),
    ),
  };
  const events = { on: jest.fn() };
  const notifications = { contentApproval: jest.fn(() => Promise.resolve()) };
  const audit = { record: jest.fn(() => Promise.resolve()) };
  const transactions = {
    execute: jest.fn((fn: (prisma: unknown) => unknown) => fn({})),
  };
  const service = new ContentApprovalService(
    content as never,
    items as never,
    files as never,
    requests as never,
    configs as never,
    events as never,
    notifications as never,
    audit as never,
    transactions as never,
  );
  return { service, items, requests, notifications };
}

describe('CD-272 content approval', () => {
  it('raises and submits a request of the configured type with what is approved', async () => {
    const { service, requests, items } = harness();

    await service.send(actor, 'c-1');

    expect(requests.create).toHaveBeenCalledWith(
      expect.objectContaining({
        type_code: 'CNA',
        form_data: expect.objectContaining({
          caption: 'ลด 20%',
          channel: 'Facebook',
          mentions: 'ราคา',
          media: 'banner.png',
          content_version: '3',
        }),
      }),
      actor,
    );
    expect(requests.submit).toHaveBeenCalledWith('req-1', actor, '');
    expect(items.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'pending_approval',
          approvalRequestId: 'req-1',
        }),
      }),
      expect.anything(),
    );
  });

  it('a request that cannot be submitted is withdrawn, not left as a draft', async () => {
    const { service, requests, items } = harness({ submitFails: true });
    await expect(service.send(actor, 'c-1')).rejects.toThrow('ไม่มีผู้อนุมัติ');
    expect(requests.cancel).toHaveBeenCalled();
    expect(items.updateMany).not.toHaveBeenCalled();
  });

  it('refuses without a configured type, for unflagged content, or when not a draft', async () => {
    await expect(
      harness({ typeCode: null }).service.send(actor, 'c-1'),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await expect(
      harness({ found: item({ mentionsPrice: false }) }).service.send(
        actor,
        'c-1',
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      harness({ found: item({ status: 'ready' }) }).service.send(actor, 'c-1'),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    // all content needs approval: unflagged may be sent
    await expect(
      harness({
        found: item({ mentionsPrice: false }),
        all: true,
      }).service.send(actor, 'c-1'),
    ).resolves.toBeDefined();
  });

  it('approved → Ready for that version; rejected → Draft with a note; the owner hears', async () => {
    const pending = item({
      status: 'pending_approval',
      approvalRequestId: 'req-1',
    });
    const ok = harness({ pending });
    await ok.service.onRequestOutcome(
      { request_id: 'req-1', request_no: 'REQ-1' } as never,
      'approved',
    );
    expect(ok.items.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'ready',
          approvalStatus: 'approved',
          approvedVersion: 3,
        }),
      }),
      expect.anything(),
    );
    expect(ok.notifications.contentApproval).toHaveBeenCalledWith(
      'u-owner',
      'osd',
      expect.objectContaining({ kind: 'approved' }),
    );

    const no = harness({ pending });
    await no.service.onRequestOutcome(
      { request_id: 'req-1', request_no: 'REQ-1' } as never,
      'rejected',
    );
    expect(no.items.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'draft',
          approvalStatus: 'rejected',
          approvalNote: 'ไม่อนุมัติ — ดูเหตุผลในคำขอ REQ-1',
        }),
      }),
      expect.anything(),
    );
  });

  it('someone else’s request is ignored', async () => {
    const { service, items } = harness({ pending: null });
    await service.onRequestOutcome(
      { request_id: 'other', request_no: null } as never,
      'approved',
    );
    expect(items.updateMany).not.toHaveBeenCalled();
  });
});
