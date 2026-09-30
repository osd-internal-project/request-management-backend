import type { Principal } from '@request-management/share';
import {
  fill,
  markClauses,
  sameClauses,
  templateProblems,
  termVariable,
  versionProblems,
} from './contract-drafts';
import { ContractDraftsService } from './contract-drafts.service';

describe('CD-146 draft rules', () => {
  it('fills what has a value and keeps {{name}} where nothing was found', () => {
    expect(
      fill(
        'ระหว่าง {{our_name}} กับ {{ party_name }} มูลค่า {{contract_value}}',
        {
          our_name: 'บริษัท เรา จำกัด',
          party_name: 'บริษัท ลูกค้า จำกัด',
          contract_value: '',
        },
      ),
    ).toEqual({
      text: 'ระหว่าง บริษัท เรา จำกัด กับ บริษัท ลูกค้า จำกัด มูลค่า {{contract_value}}',
      missing: ['contract_value'],
    });
  });

  it('a template uses only the known variables — and any negotiated term', () => {
    expect(termVariable('PAY-TERM 30')).toBe('term_pay_term_30');
    const clause = (body: string, key = 'c1') => ({
      key,
      heading: 'ข้อ 1',
      body,
    });
    expect(
      templateProblems([clause('{{party_name}} ชำระภายใน {{term_payment}}')]),
    ).toEqual([]);
    expect(templateProblems([clause('{{customer_nickname}}')])).toEqual([
      'ไม่รู้จักตัวแปร {{customer_nickname}}',
    ]);
    expect(templateProblems([])).toEqual(['แม่แบบต้องมีอย่างน้อยหนึ่งข้อ']);
    expect(
      templateProblems([clause('x'), { key: 'c1', heading: ' ', body: ' ' }]),
    ).toEqual([
      'ข้อ 2: ต้องมีหัวข้อ',
      'ข้อ 2: ต้องมีเนื้อความ',
      'ข้อ 2: รหัสข้อซ้ำ',
    ]);
  });

  it('marks each clause against the template: as filled, edited, added — and lists what was taken out', () => {
    const template = [
      { key: 'c1', heading: 'คู่สัญญา', body: 'ระหว่าง ก กับ ข' },
      { key: 'c2', heading: 'ค่าปรับ', body: 'ร้อยละ 0.1 ต่อวัน' },
      { key: 'c3', heading: 'ระงับข้อพิพาท', body: 'ศาลไทย' },
    ];
    const result = markClauses(
      [
        // only line endings and trailing spaces differ: still the template
        { key: 'c1', heading: 'คู่สัญญา', body: 'ระหว่าง ก กับ ข  \r\n' },
        { key: 'c2', heading: 'ค่าปรับ', body: 'ร้อยละ 0.05 ต่อวัน' },
        { key: 'new-1', heading: 'ข้อมูลส่วนบุคคล', body: 'ตาม PDPA' },
      ],
      template,
    );
    expect(result.clauses.map((clause) => clause.mark)).toEqual([
      'template',
      'edited',
      'added',
    ]);
    expect(result.clauses[1].templateBody).toBe('ร้อยละ 0.1 ต่อวัน');
    expect(result.removed.map((clause) => clause.key)).toEqual(['c3']);
  });

  it('two versions are the same text clause by clause; a version needs headings and unique keys', () => {
    const a = [{ key: 'c1', heading: 'ก', body: 'x' }];
    expect(sameClauses(a, [{ key: 'c1', heading: 'ก ', body: 'x\n' }])).toBe(
      true,
    );
    expect(sameClauses(a, [{ key: 'c1', heading: 'ก', body: 'y' }])).toBe(
      false,
    );
    expect(
      versionProblems([
        { key: 'c1', heading: '', body: '' },
        { key: 'c1', heading: 'ข', body: '' },
      ]),
    ).toEqual(['ข้อ 1: ต้องมีหัวข้อ', 'ข้อ 2: รหัสข้อซ้ำ']);
  });
});

const legal = {
  userId: 'u-legal',
  activeCompanyId: 'osd',
  permissions: ['legal.contract.read', 'legal.contract.manage'],
} as unknown as Principal;

function harness(options: {
  status?: string;
  typeCode?: string;
  latest?: number;
}) {
  const request = {
    id: 'req-1',
    requestNo: 'CTR-2569-0001',
    companyId: 'osd',
    typeCode: options.typeCode ?? 'CTR',
    status: options.status ?? 'in_progress',
    refType: 'opportunity',
    refId: 'OPP-001',
    formData: { contract_value: 1_200_000, end_date: '2027-09-30' },
  };
  const template = {
    id: 't-1',
    code: 'SVC',
    active: true,
    clauses: [
      {
        key: 'c1',
        heading: 'คู่สัญญา',
        body: 'ระหว่าง {{our_name}} กับ {{party_name}} ({{party_address}})',
      },
      {
        key: 'c2',
        heading: 'ค่าตอบแทน',
        body: '{{contract_value}} บาท ชำระ {{term_payment}} ถึง {{end_date}}',
      },
    ],
  };
  const created: Record<string, unknown>[] = [];
  const draftRow = {
    id: 'd-1',
    companyId: 'osd',
    requestId: 'req-1',
    templateClauses: [] as unknown,
    latestVersionNo: options.latest ?? 1,
    missing: [] as string[],
    template: { id: 't-1', code: 'SVC', name: 'บริการ' },
  };
  let versionClauses: unknown = [];
  const tx = {
    contractDraft: {
      findUnique: jest.fn(() => Promise.resolve(null)),
      findUniqueOrThrow: jest.fn(() =>
        Promise.resolve({ latestVersionNo: draftRow.latestVersionNo }),
      ),
      create: jest.fn((args: { data: Record<string, unknown> }) => {
        Object.assign(draftRow, args.data);
        return Promise.resolve({ id: 'd-1', ...args.data });
      }),
      updateMany: jest.fn((args: { data: { latestVersionNo: number } }) => {
        draftRow.latestVersionNo = args.data.latestVersionNo;
        return Promise.resolve({ count: 1 });
      }),
    },
    contractDraftApproval: {
      updateMany: jest.fn(() => Promise.resolve({ count: 0 })),
    },
    contractDraftVersion: {
      create: jest.fn((args: { data: Record<string, unknown> }) => {
        created.push(args.data);
        versionClauses = args.data.clauses;
        return Promise.resolve(args.data);
      }),
      findUniqueOrThrow: jest.fn(() =>
        Promise.resolve({ clauses: versionClauses }),
      ),
    },
  };
  const service = new ContractDraftsService(
    { findFirst: jest.fn(() => Promise.resolve(draftRow)) } as never,
    {
      findFirst: jest.fn(() =>
        Promise.resolve({
          id: 'v',
          versionNo: draftRow.latestVersionNo,
          clauses: versionClauses,
          note: null,
          createdAt: new Date(),
          createdBy: 'u-legal',
        }),
      ),
      findMany: jest.fn(() => Promise.resolve([])),
    } as never,
    {
      usable: jest.fn(() => Promise.resolve(template)),
      list: jest.fn(() => Promise.resolve([template])),
    } as never,
    { findFirst: jest.fn(() => Promise.resolve(request)) } as never,
    {
      findFirst: jest.fn(() =>
        Promise.resolve({
          contractRequestTypeCode: 'CTR',
          letterheadNameTh: 'บริษัท โอเอสดี จำกัด',
          letterheadTaxId: null,
          letterheadAddress: null,
        }),
      ),
    } as never,
    {
      findFirst: jest.fn(() =>
        Promise.resolve({
          id: 'opp-1',
          opportunityCode: 'OPP-001',
          title: 'ระบบ ERP',
          amount: 900_000,
          currency: 'THB',
          customerId: 'cus-1',
        }),
      ),
    } as never,
    {
      findFirst: jest.fn(() =>
        Promise.resolve({
          terms: [
            {
              code: 'PAYMENT',
              name: 'การชำระเงิน',
              agreed: 'ภายใน 30 วัน',
              standard: null,
              nonStandard: false,
              note: null,
            },
          ],
        }),
      ),
    } as never,
    {
      findFirst: jest.fn(() =>
        Promise.resolve({
          nameTh: 'บริษัท ลูกค้า จำกัด',
          taxId: '0105551234567',
          branchName: 'สำนักงานใหญ่',
        }),
      ),
    } as never,
    { findFirst: jest.fn(() => Promise.resolve(null)) } as never,
    { findMany: jest.fn(() => Promise.resolve([])) } as never,
    { execute: (work: (client: typeof tx) => unknown) => work(tx) } as never,
    { record: jest.fn(() => Promise.resolve()) } as never,
  );
  return { service, tx, created, draftRow };
}

describe('CD-146 ContractDraftsService', () => {
  it('starts version 1 from the template, filled from the request, deal, customer, terms and letterhead', async () => {
    const { service, created, draftRow } = harness({});
    await service.start({ request_id: 'req-1', template_id: 't-1' }, legal);
    const clauses = created[0].clauses as { body: string }[];
    expect(clauses[0].body).toBe(
      // no address on file: left for Legal to write in
      'ระหว่าง บริษัท โอเอสดี จำกัด กับ บริษัท ลูกค้า จำกัด ({{party_address}})',
    );
    expect(clauses[1].body).toBe(
      // the form's value wins over the deal's amount
      '1,200,000.00 บาท ชำระ ภายใน 30 วัน ถึง 30 กันยายน 2570',
    );
    expect(draftRow.missing).toEqual(['party_address']);
    expect(created[0]).toMatchObject({ versionNo: 1 });
  });

  it('only a contract request takes a draft; a finished one is read-only', async () => {
    const other = harness({ typeCode: 'DSC' });
    await expect(other.service.forRequest('req-1', legal)).resolves.toEqual({
      eligible: false,
      draft: null,
      templates: [],
    });
    const closed = harness({ status: 'completed' });
    await expect(
      closed.service.start({ request_id: 'req-1', template_id: 't-1' }, legal),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('each save is the next version; a stale editor or no change is refused', async () => {
    const { service, created } = harness({});
    await service.start({ request_id: 'req-1', template_id: 't-1' }, legal);
    const first = created[0].clauses as {
      key: string;
      heading: string;
      body: string;
    }[];
    const view = await service.saveVersion(
      'd-1',
      {
        base_version: 1,
        note: 'แก้ค่าตอบแทน',
        clauses: [
          first[0],
          { ...first[1], body: 'ตามใบเสนอราคา' },
          { heading: 'ข้อมูลส่วนบุคคล', body: 'ตาม PDPA' },
        ],
      },
      legal,
    );
    expect(created[1]).toMatchObject({ versionNo: 2, note: 'แก้ค่าตอบแทน' });
    expect(
      (created[1].clauses as { key: string }[])[2].key.startsWith('new-'),
    ).toBe(true);
    expect(view.counts).toEqual({ edited: 1, added: 1, removed: 0 });

    await expect(
      service.saveVersion(
        'd-1',
        { base_version: 1, clauses: [first[0]] },
        legal,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      service.saveVersion(
        'd-1',
        {
          base_version: 2,
          clauses: created[1].clauses as {
            key: string;
            heading: string;
            body: string;
          }[],
        },
        legal,
      ),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'ไม่มีข้อความที่เปลี่ยนจากฉบับล่าสุด',
    });
  });
});
