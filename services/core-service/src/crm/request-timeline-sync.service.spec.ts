import { RequestTimelineSyncService } from './request-timeline-sync.service';

const payload = {
  company_id: 'company-osd',
  request_id: 'req-1',
  request_no: 'REQ-OSD-GEN-69090001',
  type_code: 'GEN',
  requester_id: 'u-1',
};

function harness(
  request: Record<string, unknown> | null,
  options: {
    opportunity?: unknown;
    quotation?: unknown;
    exists?: boolean;
  } = {},
) {
  const published: Record<string, unknown>[] = [];
  const requests = { findFirst: jest.fn(() => Promise.resolve(request)) };
  const opportunities = {
    findFirst: jest.fn(() => Promise.resolve(options.opportunity ?? null)),
  };
  const quotations = {
    findFirst: jest.fn(() => Promise.resolve(options.quotation ?? null)),
  };
  const timeline = {
    has: jest.fn(() => Promise.resolve(options.exists ?? false)),
    publish: jest.fn((event: Record<string, unknown>) => {
      published.push(event);
      return Promise.resolve();
    }),
  };
  const service = new RequestTimelineSyncService(
    { on: jest.fn() } as never,
    requests as never,
    opportunities as never,
    quotations as never,
    timeline as never,
  );
  return { service, published, opportunities, timeline };
}

const request = (refType: string | null, refId: string | null) => ({
  id: 'req-1',
  requestNo: 'REQ-OSD-GEN-69090001',
  companyId: 'company-osd',
  typeCode: 'GEN',
  refType,
  refId,
  typeSnapshot: { name: 'คำขอทั่วไป' },
});

describe('CD-69 RequestTimelineSyncService', () => {
  it('CD-69: a request about a customer lands on that customer’s timeline, guarded as a request row', async () => {
    const { service, published } = harness(request('customer', 'cus-1'));

    await service.onRequestEvent('request.submitted', 'ยื่นแล้ว', payload);

    expect(published).toEqual([
      expect.objectContaining({
        companyId: 'company-osd',
        customerId: 'cus-1',
        refType: 'request',
        refId: 'req-1',
        eventType: 'request.submitted',
        summary: 'คำขอ REQ-OSD-GEN-69090001 · คำขอทั่วไป — ยื่นแล้ว',
      }),
    ]);
  });

  it('CD-69: a request about an opportunity (OPP code) reaches its customer', async () => {
    const { service, published, opportunities } = harness(
      request('opportunity', 'OPP-OSD-000004'),
      { opportunity: { customerId: 'cus-9' } },
    );

    await service.onRequestEvent('request.completed', 'ปิดงาน', payload);

    expect(opportunities.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          companyId: 'company-osd',
          OR: [{ opportunityCode: 'OPP-OSD-000004' }, { id: 'OPP-OSD-000004' }],
        },
      }),
    );
    expect(published[0]).toMatchObject({ customerId: 'cus-9' });
  });

  it('CD-69: a quotation without its own customer falls back to its opportunity’s', async () => {
    const { service, published } = harness(request('quotation', 'qt-1'), {
      quotation: { customerId: null, opportunity: { customerId: 'cus-3' } },
    });

    await service.onRequestEvent('request.approved', 'อนุมัติ', payload);

    expect(published[0]).toMatchObject({ customerId: 'cus-3' });
  });

  it('a prospect (no customer yet), no ref, or an unknown ref type writes nothing', async () => {
    for (const [req, opportunity] of [
      [request('opportunity', 'OPP-X'), { customerId: null }],
      [request(null, null), null],
      [request('project', 'p-1'), null],
      [null, null],
    ] as const) {
      const { service, published } = harness(req, { opportunity });
      await service.onRequestEvent('request.submitted', 'ยื่นแล้ว', payload);
      expect(published).toHaveLength(0);
    }
  });

  it('§11.8 idempotent: a redelivered event does not add a second line', async () => {
    const { service, published, timeline } = harness(
      request('customer', 'cus-1'),
      { exists: true },
    );

    await service.onRequestEvent('request.submitted', 'ยื่นแล้ว', payload);

    expect(timeline.has).toHaveBeenCalledWith({
      customerId: 'cus-1',
      refType: 'request',
      refId: 'req-1',
      eventType: 'request.submitted',
    });
    expect(published).toHaveLength(0);
  });
});
