import { SapB1Client, type SapB1Settings } from './sap-b1.client';
import type { B1Request, B1Response, B1Transport } from './sap-b1.transport';

const BASE = 'https://b1.test:50000/b1s/v1';
const OSD = { companyCode: 'OSD' };

type Route = (req: B1Request, body: Record<string, unknown>) => B1Response;

/** What the driver sent, parsed. */
function bodyOf(req: B1Request): Record<string, unknown> {
  return JSON.parse(req.body ?? '{}') as Record<string, unknown>;
}

function reply(status: number, body?: unknown, headers = {}): B1Response {
  return {
    status,
    headers,
    body:
      body === undefined
        ? ''
        : typeof body === 'string'
          ? body
          : JSON.stringify(body),
  };
}

function b1Error(status: number, message: string): B1Response {
  return reply(status, {
    error: { code: -5002, message: { lang: 'en-us', value: message } },
  });
}

/** A fake Service Layer: routes by "METHOD path", records every request. */
function harness(
  routes: Record<string, Route> = {},
  settings: Partial<SapB1Settings> = {},
) {
  const requests: B1Request[] = [];
  let sessionNo = 0;

  const transport: B1Transport = {
    send: jest.fn((req: B1Request) => {
      requests.push(req);
      const path = req.url.slice(BASE.length);
      const body = req.body
        ? (JSON.parse(req.body) as Record<string, unknown>)
        : {};

      if (req.method === 'POST' && path === '/Login') {
        sessionNo += 1;
        return Promise.resolve(
          reply(
            200,
            { SessionId: `s${sessionNo}`, SessionTimeout: 30 },
            {
              'set-cookie': [
                `B1SESSION=s${sessionNo}; path=/b1s; HttpOnly`,
                'ROUTEID=.node1; path=/b1s',
              ],
            },
          ),
        );
      }
      const route =
        routes[`${req.method} ${path}`] ??
        routes[`${req.method} ${path.split('?')[0]}`];
      if (!route) {
        return Promise.resolve(b1Error(404, `no route ${req.method} ${path}`));
      }
      return Promise.resolve(route(req, body));
    }),
  };

  const config = {
    get: jest.fn(() => ({
      baseUrl: `${BASE}/`,
      username: 'ctd-integration',
      password: 'secret',
      companyDbs: { OSD: 'SBO_OSD', LEXTECH: 'SBO_LEX' },
      ...settings,
    })),
  };

  const client = new SapB1Client(config as never, transport);
  const calls = (method: string, pathStart: string) =>
    requests.filter(
      (r) =>
        r.method === method && r.url.slice(BASE.length).startsWith(pathStart),
    );
  return { client, requests, calls };
}

const customer = {
  customerCode: 'CUS-OSD-000001',
  name: 'บริษัท กขค จำกัด',
  taxId: '0107536001079',
  email: 'ap@kkc.co.th',
  phone: '021234567',
  street: 'เลขที่ 1 ถนนสีลม',
  street2: null,
  city: 'กรุงเทพมหานคร',
  zip: '10500',
  active: true,
};

describe('SAP B1 Service Layer driver', () => {
  it('login ครั้งเดียวต่อ CompanyDB แล้วใช้ session ซ้ำ; ส่ง B1SESSION + ROUTEID กลับทุกคำขอ', async () => {
    const h = harness({
      "GET /BusinessPartners('CUS-OSD-000001')": () =>
        reply(200, { CardCode: 'CUS-OSD-000001' }),
    });

    await expect(h.client.findCustomer(OSD, 'CUS-OSD-000001')).resolves.toEqual(
      {
        externalCode: 'CUS-OSD-000001',
      },
    );
    await h.client.findCustomer(OSD, 'CUS-OSD-000001');

    const logins = h.calls('POST', '/Login');
    expect(logins).toHaveLength(1);
    expect(bodyOf(logins[0])).toEqual({
      CompanyDB: 'SBO_OSD',
      UserName: 'ctd-integration',
      Password: 'secret',
    });
    const gets = h.calls('GET', '/BusinessPartners');
    expect(gets.map((r) => r.headers.Cookie)).toEqual([
      'B1SESSION=s1; ROUTEID=.node1',
      'B1SESSION=s1; ROUTEID=.node1',
    ]);
  });

  it('คนละบริษัท = คนละ CompanyDB = คนละ session', async () => {
    const h = harness({
      "GET /BusinessPartners('X')": () => reply(200, { CardCode: 'X' }),
    });

    await h.client.findCustomer(OSD, 'X');
    await h.client.findCustomer({ companyCode: 'LEXTECH' }, 'X');

    expect(h.calls('POST', '/Login').map((r) => bodyOf(r).CompanyDB)).toEqual([
      'SBO_OSD',
      'SBO_LEX',
    ]);
  });

  it('บริษัทที่ยังไม่ผูก CompanyDB → error ชัดเจน ไม่ยิง SAP', async () => {
    const h = harness();

    await expect(
      h.client.findCustomer({ companyCode: 'BCO' }, 'X'),
    ).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR',
      message: expect.stringContaining('ERP_B1_COMPANY_DBS') as unknown,
    });
    expect(h.requests).toHaveLength(0);
  });

  it('session หลุด (401) → login ใหม่แล้วลองซ้ำครั้งเดียว', async () => {
    let first = true;
    const h = harness({
      "GET /BusinessPartners('X')": () => {
        if (first) {
          first = false;
          return b1Error(401, 'Invalid session.');
        }
        return reply(200, { CardCode: 'X' });
      },
    });

    await expect(h.client.findCustomer(OSD, 'X')).resolves.toEqual({
      externalCode: 'X',
    });
    expect(h.calls('POST', '/Login')).toHaveLength(2);
  });

  it('findCustomer: 404 = ยังไม่มีใน SAP (null) ไม่ใช่ error', async () => {
    const h = harness();
    await expect(
      h.client.findCustomer(OSD, 'CUS-OSD-000009'),
    ).resolves.toBeNull();
  });

  it('createCustomer: CardCode = รหัสลูกค้าของเรา, ที่อยู่เป็น BillTo, active → ไม่ freeze', async () => {
    const h = harness({
      'POST /BusinessPartners': (_req, body) => reply(201, body),
    });

    await expect(h.client.createCustomer(OSD, customer)).resolves.toEqual({
      externalCode: 'CUS-OSD-000001',
    });

    const sent = bodyOf(h.calls('POST', '/BusinessPartners')[0]);
    expect(sent).toEqual({
      CardCode: 'CUS-OSD-000001',
      CardType: 'cCustomer',
      CardName: 'บริษัท กขค จำกัด',
      FederalTaxID: '0107536001079',
      EmailAddress: 'ap@kkc.co.th',
      Phone1: '021234567',
      Frozen: 'tNO',
      BPAddresses: [
        {
          AddressName: 'BILL_TO',
          AddressType: 'bo_BillTo',
          Street: 'เลขที่ 1 ถนนสีลม',
          City: 'กรุงเทพมหานคร',
          ZipCode: '10500',
          Country: 'TH',
        },
      ],
    });
  });

  it('รหัสลูกค้ายาวเกิน 15 ตัว (CardCode) → error ก่อนยิง SAP', async () => {
    const h = harness();

    await expect(
      h.client.createCustomer(OSD, {
        ...customer,
        customerCode: 'CUS-OSDXX-000001',
      }),
    ).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
    expect(h.calls('POST', '/BusinessPartners')).toHaveLength(0);
  });

  it('updateCustomer: PATCH ไม่ส่ง CardCode; ลูกค้าถูกระงับ → Frozen', async () => {
    const h = harness({
      "PATCH /BusinessPartners('CUS-OSD-000001')": () => reply(204),
    });

    await h.client.updateCustomer(OSD, 'CUS-OSD-000001', {
      ...customer,
      active: false,
    });

    const sent = bodyOf(h.calls('PATCH', '/BusinessPartners')[0]);
    expect(sent.CardCode).toBeUndefined();
    expect(sent.Frozen).toBe('tYES');
  });

  it('SAP ปฏิเสธ → ข้อความจาก B1 ติดไปกับ error (สิ่งที่ผู้ดูแลอ่าน)', async () => {
    const h = harness({
      'POST /BusinessPartners': () =>
        b1Error(400, "Invalid 'FederalTaxID' length"),
    });

    await expect(h.client.createCustomer(OSD, customer)).rejects.toMatchObject({
      message: expect.stringContaining(
        "Invalid 'FederalTaxID' length",
      ) as unknown,
    });
  });

  it('createSalesOrder: NumAtCard = เลข SO, วันที่ตามเวลาไทย, บรรทัดบริการใช้ item กลาง', async () => {
    const h = harness(
      {
        'POST /Orders': () => reply(201, { DocEntry: 88, DocNum: 1000123 }),
      },
      { serviceItemCode: 'SERVICE', warehouseCode: 'WH01', vatGroup: 'S07' },
    );

    const result = await h.client.createSalesOrder(OSD, {
      saleOrderCode: 'SO-OSD-000001',
      customerExternalCode: 'CUS-OSD-000001',
      currency: 'THB',
      // 03:00 วันที่ 24 ตามเวลาไทย = 20:00 วันที่ 23 UTC
      orderedAt: '2026-09-23T20:00:00.000Z',
      netTotal: 100000,
      lines: [
        {
          lineNo: 1,
          productCode: 'SIP-TRUNK',
          description: 'SIP Trunk 30 ช่อง',
          quantity: 2,
          unit: 'ชุด',
          unitPrice: 50000,
          discountPct: 5,
          lineTotal: 95000,
        },
        {
          lineNo: 2,
          productCode: null,
          description: 'ค่าติดตั้ง',
          quantity: 1,
          unit: null,
          unitPrice: 5000,
          discountPct: 0,
          lineTotal: 5000,
        },
      ],
    });

    expect(result).toEqual({ externalCode: '1000123' });
    const sent = bodyOf(h.calls('POST', '/Orders')[0]);
    expect(sent).toMatchObject({
      CardCode: 'CUS-OSD-000001',
      NumAtCard: 'SO-OSD-000001',
      DocDate: '2026-09-24',
      DocDueDate: '2026-09-24',
    });
    expect(sent.DocCurrency).toBeUndefined();
    expect(sent.DocumentLines).toEqual([
      {
        ItemCode: 'SIP-TRUNK',
        ItemDescription: 'SIP Trunk 30 ช่อง',
        Quantity: 2,
        UnitPrice: 50000,
        DiscountPercent: 5,
        WarehouseCode: 'WH01',
        VatGroup: 'S07',
      },
      expect.objectContaining({
        ItemCode: 'SERVICE',
        ItemDescription: 'ค่าติดตั้ง',
      }),
    ]);
  });

  it('บรรทัดไม่มีรหัสสินค้าและยังไม่ตั้ง ERP_B1_SERVICE_ITEM → error ก่อนยิง SAP', async () => {
    const h = harness();

    await expect(
      h.client.createSalesOrder(OSD, {
        saleOrderCode: 'SO-OSD-000001',
        customerExternalCode: 'CUS-OSD-000001',
        currency: 'THB',
        orderedAt: '2026-09-24T03:00:00.000Z',
        netTotal: 5000,
        lines: [
          {
            lineNo: 1,
            productCode: null,
            description: 'ค่าติดตั้ง',
            quantity: 1,
            unit: null,
            unitPrice: 5000,
            discountPct: 0,
            lineTotal: 5000,
          },
        ],
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('ERP_B1_SERVICE_ITEM') as unknown,
    });
    expect(h.calls('POST', '/Orders')).toHaveLength(0);
  });

  it('findSalesOrder: ค้นด้วย NumAtCard (เข้ารหัส %20 ไม่ใช่ +) ได้ DocNum', async () => {
    const h = harness({
      'GET /Orders': () =>
        reply(200, {
          value: [{ DocEntry: 88, DocNum: 1000123, Cancelled: 'tNO' }],
        }),
    });

    await expect(
      h.client.findSalesOrder(OSD, 'SO-OSD-000001'),
    ).resolves.toEqual({
      externalCode: '1000123',
    });
    const url = h.calls('GET', '/Orders')[0].url;
    expect(url).toContain("$filter=NumAtCard%20eq%20'SO-OSD-000001'");
    expect(url).not.toContain('+');
  });

  it('cancelSalesOrder: หา DocEntry จาก NumAtCard แล้ว POST Cancel; ยกเลิกแล้ว = ไม่ยิงซ้ำ', async () => {
    let cancelled = 'tNO';
    const h = harness({
      'GET /Orders': () =>
        reply(200, {
          value: [{ DocEntry: 88, DocNum: 1000123, Cancelled: cancelled }],
        }),
      'POST /Orders(88)/Cancel': () => {
        cancelled = 'tYES';
        return reply(204);
      },
    });
    const target = { externalCode: '1000123', saleOrderCode: 'SO-OSD-000001' };

    await h.client.cancelSalesOrder(OSD, target, 'ลูกค้ายกเลิก');
    await h.client.cancelSalesOrder(OSD, target, 'ลูกค้ายกเลิก');

    expect(h.calls('POST', '/Orders(88)/Cancel')).toHaveLength(1);
  });

  it('getReceivables: CurrentAccountBalance + จำนวนใบแจ้งหนี้ที่ยังเปิด', async () => {
    const h = harness({
      "GET /BusinessPartners('CUS-OSD-000001')?$select=CurrentAccountBalance":
        () => reply(200, { CurrentAccountBalance: 125000.5 }),
      'GET /Invoices/$count': () => reply(200, '3'),
    });

    await expect(
      h.client.getReceivables(OSD, 'CUS-OSD-000001'),
    ).resolves.toMatchObject({ outstanding: 125000.5, invoiceCount: 3 });
  });

  it('missingSettings: บอกตัวแปรที่ขาดเมื่อเปิด ERP_MODE=sapb1', () => {
    expect(
      SapB1Client.missingSettings({ baseUrl: BASE, companyDbs: {} }),
    ).toEqual(['ERP_B1_USERNAME', 'ERP_B1_PASSWORD', 'ERP_B1_COMPANY_DBS']);
  });
});
