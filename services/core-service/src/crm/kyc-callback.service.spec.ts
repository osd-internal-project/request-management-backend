import { KycCallbackService } from './kyc-callback.service';

function harness(options: { kycVerified?: boolean; refType?: string | null } = {}) {
  const updates: Record<string, unknown>[] = [];
  const audits: { eventType: string }[] = [];
  const timelineEvents: { eventType: string }[] = [];

  const events = { on: jest.fn() };
  const requests = {
    findFirst: jest.fn(() =>
      Promise.resolve({
        id: 'req-1',
        requestNo: 'OSD-KYC-202609-0001',
        refType: options.refType === undefined ? 'customer' : options.refType,
        refId: 'cust-1',
      }),
    ),
  };
  const customers = {
    findFirst: jest.fn(() =>
      Promise.resolve({
        id: 'cust-1',
        companyId: 'osd',
        customerCode: 'CUS-OSD-000001',
        kycVerified: options.kycVerified ?? false,
      }),
    ),
    update: jest.fn((args: { data: Record<string, unknown> }) => {
      updates.push(args.data);
      return Promise.resolve({});
    }),
  };
  const fieldChanges = { createMany: jest.fn(() => Promise.resolve({ count: 1 })) };
  const timeline = {
    publish: jest.fn((event: { eventType: string }) => {
      timelineEvents.push(event);
      return Promise.resolve();
    }),
  };
  const audit = {
    record: jest.fn((entry: { eventType: string }) => {
      audits.push(entry);
      return Promise.resolve();
    }),
  };

  const service = new KycCallbackService(
    events as never,
    requests as never,
    customers as never,
    fieldChanges as never,
    timeline as never,
    audit as never,
  );

  return { service, updates, audits, timelineEvents, customers };
}

describe('CM-04 ชุดงาน B — KYC callback ติด kycVerified เมื่อคำขอเสร็จ', () => {
  it('CM-04 a completed KYC request flips the flag with history, audit and timeline', async () => {
    const { service, updates, audits, timelineEvents } = harness();

    await service.onRequestCompleted({ request_id: 'req-1', type_code: 'KYC' });

    expect(updates[0]).toMatchObject({ kycVerified: true });
    expect(audits.map((a) => a.eventType)).toContain('crm.customer.kyc_verified');
    expect(timelineEvents.map((t) => t.eventType)).toContain(
      'customer.kyc_verified',
    );
  });

  it('CM-04 a non-KYC completion is ignored entirely', async () => {
    const { service, updates, customers } = harness();

    await service.onRequestCompleted({ request_id: 'req-1', type_code: 'DSC' });

    expect(updates).toHaveLength(0);
    expect(customers.findFirst).not.toHaveBeenCalled();
  });

  it('CM-04 idempotent — an already-verified customer is not rewritten', async () => {
    const { service, updates, audits } = harness({ kycVerified: true });

    await service.onRequestCompleted({ request_id: 'req-1', type_code: 'KYC' });

    expect(updates).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });

  it('CM-04 a KYC request without a customer ref logs and stops', async () => {
    const { service, updates } = harness({ refType: 'deal' });

    await service.onRequestCompleted({ request_id: 'req-1', type_code: 'KYC' });

    expect(updates).toHaveLength(0);
  });
});
