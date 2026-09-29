import type { Principal } from '@request-management/share';
import { approvalTypeFor, readApprovalTypes } from './customer-approval';
import { CustomerApprovalService } from './customer-approval.service';

const seller = {
  userId: 'sales-1',
  displayName: 'สมชาย ขายดี',
  activeCompanyId: 'osd',
  orgUnitId: 'ou-sales',
  ledUnitIds: [],
  permissions: ['crm.customer.read', 'request.create'],
} as unknown as Principal;

describe('CD-62 which type approves a new customer', () => {
  it('per customer type; nothing configured (or junk) = no approval', () => {
    const configured = {
      corporate: 'NCA-CORP',
      individual: '',
      government: 'bad code!',
    };
    expect(approvalTypeFor(configured, 'corporate')).toBe('NCA-CORP');
    expect(approvalTypeFor(configured, 'individual')).toBeNull();
    expect(approvalTypeFor(configured, 'government')).toBeNull();
    expect(approvalTypeFor(null, 'corporate')).toBeNull();
    expect(approvalTypeFor(['NCA'], 'corporate')).toBeNull();
    expect(readApprovalTypes({ corporate: 'NCA-CORP', other: 'X' })).toEqual({
      corporate: 'NCA-CORP',
    });
  });
});

describe('CD-62 CustomerApprovalService', () => {
  function harness(
    options: {
      pending?: boolean;
      claim?: number;
      openOrders?: string[];
      customer?: Record<string, unknown> | null;
      request?: Record<string, unknown> | null;
      typeCode?: string | null;
    } = {},
  ) {
    const audits: string[] = [];
    const timeline: string[] = [];
    const customerUpdates: Record<string, unknown>[] = [];
    const kicked: string[] = [];
    const created: Record<string, unknown>[] = [];
    const visible =
      options.customer === undefined
        ? {
            id: 'cus-1',
            companyId: 'osd',
            customerCode: 'CUS-OSD-000010',
            nameTh: 'บริษัท ใหม่ จำกัด',
            taxId: '0105551234567',
            type: 'corporate',
            approvalStatus: 'rejected',
            approvalRequestId: 'req-old',
          }
        : options.customer;
    const customers = {
      findFirst: jest.fn((args: { where: Record<string, unknown> }) => {
        if ('approvalRequestId' in args.where) {
          return Promise.resolve(
            options.pending === false
              ? null
              : {
                  id: 'cus-1',
                  companyId: 'osd',
                  customerCode: 'CUS-OSD-000010',
                  nameTh: 'บริษัท ใหม่ จำกัด',
                },
          );
        }
        return Promise.resolve(visible);
      }),
      updateMany: jest.fn((args: { data: Record<string, unknown> }) => {
        customerUpdates.push(args.data);
        return Promise.resolve({ count: options.claim ?? 1 });
      }),
      update: jest.fn((args: { data: Record<string, unknown> }) => {
        customerUpdates.push(args.data);
        return Promise.resolve({});
      }),
    };
    const service = new CustomerApprovalService(
      customers as never,
      {
        findFirst: jest.fn(() =>
          Promise.resolve({
            customerApprovalTypes:
              options.typeCode === null
                ? {}
                : { corporate: options.typeCode ?? 'NCA-CORP' },
          }),
        ),
      } as never,
      {
        findFirst: jest.fn(() =>
          Promise.resolve(
            options.request === undefined
              ? {
                  id: 'req-old',
                  requestNo: 'NCA-1',
                  status: 'rejected',
                  typeCode: 'NCA-CORP',
                }
              : options.request,
          ),
        ),
      } as never,
      {
        findMany: jest.fn((args: { where: { code: { in: string[] } } }) =>
          Promise.resolve(
            args.where.code.in
              .filter((code) => code.startsWith('NCA-'))
              .map((code) => ({ code })),
          ),
        ),
      } as never,
      {
        create: jest.fn((dto: Record<string, unknown>) => {
          created.push(dto);
          return Promise.resolve({ id: 'req-new', requestNo: null });
        }),
      } as never,
      {
        findMany: jest.fn(() =>
          Promise.resolve((options.openOrders ?? []).map((id) => ({ id }))),
        ),
      } as never,
      {
        kickCustomer: jest.fn((id: string) => kicked.push(`customer:${id}`)),
      } as never,
      {
        kickCreate: jest.fn((id: string) => kicked.push(`order:${id}`)),
      } as never,
      { on: jest.fn() } as never,
      {
        publish: jest.fn((event: { eventType: string }) => {
          timeline.push(event.eventType);
          return Promise.resolve();
        }),
      } as never,
      {
        record: jest.fn((event: { eventType: string }) => {
          audits.push(event.eventType);
          return Promise.resolve();
        }),
      } as never,
      {
        execute: jest.fn((work: (p: unknown) => unknown) => work({})),
      } as never,
    );
    return { service, audits, timeline, customerUpdates, kicked, created };
  }

  const event = {
    company_id: 'osd',
    request_id: 'req-1',
    request_no: 'NCA-CORP-2609-0001',
    type_code: 'NCA-CORP',
    requester_id: 'sales-1',
  };

  it('CD-62: approved → the customer, then each of its unsent sale orders, go to SAP', async () => {
    const h = harness({ openOrders: ['so-1', 'so-2'] });
    await h.service.onRequestOutcome(event, 'approved');
    expect(h.customerUpdates).toEqual([{ approvalStatus: 'approved' }]);
    expect(h.kicked).toEqual(['customer:cus-1', 'order:so-1', 'order:so-2']);
    expect(h.audits).toEqual(['crm.customer.approved']);
    expect(h.timeline).toEqual(['customer.approved']);
  });

  it('CD-62: rejected or cancelled → rejected, and nothing goes to SAP', async () => {
    const h = harness({ openOrders: ['so-1'] });
    await h.service.onRequestOutcome(event, 'rejected');
    expect(h.customerUpdates).toEqual([{ approvalStatus: 'rejected' }]);
    expect(h.kicked).toEqual([]);
    expect(h.audits).toEqual(['crm.customer.approval_rejected']);
  });

  it('a request that is not a pending customer’s, or a repeated event, changes nothing', async () => {
    const other = harness({ pending: false });
    await other.service.onRequestOutcome(event, 'approved');
    expect(other.customerUpdates).toEqual([]);

    const again = harness({ claim: 0, openOrders: ['so-1'] });
    await again.service.onRequestOutcome(event, 'approved');
    expect(again.kicked).toEqual([]);
    expect(again.audits).toEqual([]);
  });

  it('a draft request is raised on the customer, prefilled, and the customer points at it', async () => {
    const h = harness({});
    await h.service.raiseFor(
      {
        id: 'cus-1',
        companyId: 'osd',
        customerCode: 'CUS-OSD-000010',
        nameTh: 'บริษัท ใหม่ จำกัด',
        taxId: '0105551234567',
        type: 'corporate',
      },
      'NCA-CORP',
      seller,
    );
    expect(h.created[0]).toMatchObject({
      type_code: 'NCA-CORP',
      ref_type: 'customer',
      ref_id: 'cus-1',
      form_data: {
        customer_code: 'CUS-OSD-000010',
        customer_type: 'นิติบุคคล',
        tax_id: '0105551234567',
      },
    });
    expect(h.customerUpdates).toEqual([
      { approvalStatus: 'pending', approvalRequestId: 'req-new' },
    ]);
    expect(h.audits).toEqual(['crm.customer.approval_requested']);
  });

  it('after a rejection, a new request may be raised from the page', async () => {
    const h = harness({});
    await expect(
      h.service.raiseFromPage('cus-1', seller),
    ).resolves.toMatchObject({
      status: 'rejected',
    });
    expect(h.created).toHaveLength(1);
  });

  it('not while one is still in flight, nor for an approved customer, nor with no type set', async () => {
    await expect(
      harness({
        request: {
          id: 'req-old',
          requestNo: 'NCA-1',
          status: 'submitted',
          typeCode: 'NCA-CORP',
        },
      }).service.raiseFromPage('cus-1', seller),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    await expect(
      harness({
        customer: {
          id: 'cus-1',
          companyId: 'osd',
          customerCode: 'C',
          nameTh: 'x',
          taxId: null,
          type: 'corporate',
          approvalStatus: 'approved',
          approvalRequestId: null,
        },
      }).service.raiseFromPage('cus-1', seller),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    await expect(
      harness({ typeCode: null }).service.raiseFromPage('cus-1', seller),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('CRM settings refuse a code that is not a request type this company can raise', async () => {
    const { service } = harness({});
    await expect(
      service.assertUsableTypes('osd', {
        corporate: 'NCA-CORP',
        individual: 'TYPO',
      }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: [{ field: 'customer_approval_types', reason: 'TYPO' }],
    });
    await expect(
      service.assertUsableTypes('osd', {
        corporate: 'NCA-CORP',
        government: '',
      }),
    ).resolves.toEqual({ corporate: 'NCA-CORP' });
  });

  it('SCOPE-03: a customer out of reach is 404', async () => {
    await expect(
      harness({ customer: null }).service.view('cus-9', seller),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
