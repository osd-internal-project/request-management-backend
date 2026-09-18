import { PERMISSIONS_KEY, Principal } from '@request-management/share';
import { QuotationPrintService } from './quotation-print.service';
import { QuotationsController } from './quotations.controller';

function principal(): Principal {
  return {
    userId: 'me',
    activeCompanyId: 'osd',
    orgUnitId: 'unit-sales',
    ledUnitIds: [],
    scopedUnitIds: [],
    // A manager who *may* see cost — the printout must still not carry it.
    permissions: ['crm.sales.read', 'crm.sales.manage', 'crm.sales.read.all'],
  } as unknown as Principal;
}

const ROW = {
  id: 'q1',
  quotationNo: 'QT-OSD-000001',
  version: 2,
  status: 'approved',
  title: 'ระบบ Call Center',
  currency: 'THB',
  validUntil: null,
  paymentTerms: '30 วัน',
  note: null,
  partyName: 'บริษัท ผู้มุ่งหวัง จำกัด',
  partyTaxId: '0105560012345',
  contactName: 'คุณสมหญิง',
  subtotal: '100000',
  discountTotal: '0',
  netTotal: '100000',
  vatPct: '7',
  vatAmount: '7000',
  grandTotal: '107000',
  createdAt: new Date('2026-09-18T00:00:00Z'),
  sentAt: null,
  ownerUserId: 'sales-1',
  companyId: 'osd',
  company: { name: 'OSD' },
  customer: null,
  lines: [],
};

function harness(
  options: {
    found?: Record<string, unknown> | null;
    config?: Record<string, string | null> | null;
  } = {},
) {
  const quotations = {
    findFirst: jest.fn(() =>
      Promise.resolve(options.found === undefined ? ROW : options.found),
    ),
  };
  const configs = {
    findFirst: jest.fn(() => Promise.resolve(options.config ?? null)),
  };
  const members = {
    findMany: jest.fn(() =>
      Promise.resolve([{ displayName: 'วิชัย ส.', email: 'w@osd.co.th' }]),
    ),
  };
  const service = new QuotationPrintService(
    quotations as never,
    configs as never,
    members as never,
  );
  return { service, quotations };
}

type Select = Record<string, unknown> & { lines: { select: object } };
const selectOf = (mock: jest.Mock) =>
  (mock.mock.calls[0] as unknown as [{ select: Select }])[0].select;

describe('CD-76 ใบเสนอราคาฉบับพิมพ์', () => {
  it('CD-76 the printout never selects cost or margin, even for a viewer allowed to see them', async () => {
    const { service, quotations } = harness();

    const view = await service.printView('q1', principal());

    const select = selectOf(quotations.findFirst);
    for (const hidden of [
      'costTotal',
      'marginAmount',
      'marginPct',
      'minMarginPct',
    ]) {
      expect(select).not.toHaveProperty(hidden);
    }
    expect(select.lines.select).not.toHaveProperty('unitCost');
    expect(select.lines.select).not.toHaveProperty('lineCost');
    expect(view.quotation).not.toHaveProperty('ownerUserId');
    expect(view.quotation).not.toHaveProperty('companyId');
  });

  it('CD-76 a prospect is billed by the name on the quotation; no letterhead config falls back to the company name', async () => {
    const { service } = harness();

    const view = await service.printView('q1', principal());

    expect(view.billTo).toMatchObject({
      name: 'บริษัท ผู้มุ่งหวัง จำกัด',
      taxId: '0105560012345',
      branch: null,
      address: null,
    });
    expect(view.letterhead).toMatchObject({ nameTh: 'OSD', logo: null });
    expect(view.seller).toEqual({ name: 'วิชัย ส.', email: 'w@osd.co.th' });
    expect(view.isFinal).toBe(true);
  });

  it('CD-76 a registered customer is billed with its branch and billing address', async () => {
    const { service } = harness({
      found: {
        ...ROW,
        status: 'draft',
        customer: {
          customerCode: 'CUS-OSD-000002',
          nameTh: 'ธนาคาร ก จำกัด (มหาชน)',
          taxId: '0107536000315',
          branchCode: '00012',
          branchName: 'สาขาราชวงศ์',
          locations: [
            {
              line1: '1 ถนนราชวงศ์',
              line2: null,
              subDistrict: 'จักรวรรดิ',
              district: 'สัมพันธวงศ์',
              province: 'กรุงเทพมหานคร',
              postalCode: '10100',
            },
          ],
        },
      },
      config: {
        letterheadNameTh: 'บริษัท โอเอสดี จำกัด',
        letterheadTaxId: '0105500000001',
      },
    });

    const view = await service.printView('q1', principal());

    expect(view.billTo).toMatchObject({
      name: 'ธนาคาร ก จำกัด (มหาชน)',
      branch: 'สาขาราชวงศ์',
      address: '1 ถนนราชวงศ์ จักรวรรดิ สัมพันธวงศ์ กรุงเทพมหานคร 10100',
    });
    expect(view.letterhead).toMatchObject({
      nameTh: 'บริษัท โอเอสดี จำกัด',
      taxId: '0105500000001',
    });
    // Draft = watermarked, not a document to send.
    expect(view.isFinal).toBe(false);
  });

  it('CD-76 SCOPE-03 a quotation outside scope or company answers 404', async () => {
    const { service } = harness({ found: null });

    await expect(service.printView('q-x', principal())).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('CD-76 ROLE-01 printing needs crm.sales.read', () => {
    const handler = Object.getOwnPropertyDescriptor(
      QuotationsController.prototype,
      'printView',
    )?.value as object;
    expect(Reflect.getMetadata(PERMISSIONS_KEY, handler)).toEqual([
      'crm.sales.read',
    ]);
  });
});
