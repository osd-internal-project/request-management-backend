import type { Principal } from '@request-management/share';
import { ContractRequestPackageService } from './contract-request-package.service';

const legal = {
  userId: 'u-legal',
  activeCompanyId: 'osd',
  permissions: ['legal.contract.read', 'legal.contract.manage'],
} as unknown as Principal;

function harness(options: {
  typeCode?: string;
  refType?: string;
  status?: string;
  round?: boolean;
  solution?: boolean;
}) {
  const request = {
    id: 'req-1',
    companyId: 'osd',
    typeCode: options.typeCode ?? 'CTR',
    status: options.status ?? 'submitted',
    refType: options.refType ?? 'opportunity',
    refId: 'OPP-001',
  };
  let stored: Record<string, unknown> | null = null;
  const packages = {
    findFirst: jest.fn(() => Promise.resolve(stored)),
    upsert: jest.fn(
      (args: {
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        stored = stored ? { ...stored, ...args.update } : { ...args.create };
        return Promise.resolve(stored);
      },
    ),
  };
  let onSubmitted: ((event: { payload: unknown }) => Promise<void>) | null =
    null;
  const service = new ContractRequestPackageService(
    packages as never,
    { findFirst: jest.fn(() => Promise.resolve(request)) } as never,
    {
      findFirst: jest.fn(() =>
        Promise.resolve({ contractRequestTypeCode: 'CTR' }),
      ),
    } as never,
    { findFirst: jest.fn(() => Promise.resolve({ id: 'opp-1' })) } as never,
    {
      findFirst: jest.fn(() =>
        Promise.resolve(
          options.round === false
            ? null
            : {
                roundNo: 2,
                terms: [
                  {
                    code: 'PAYMENT',
                    name: 'การชำระเงิน',
                    agreed: 'ภายใน 45 วัน',
                    standard: 'ภายใน 30 วัน',
                    nonStandard: true,
                    note: null,
                  },
                ],
              },
        ),
      ),
    } as never,
    {
      findFirst: jest.fn(() =>
        Promise.resolve(
          options.solution === false
            ? null
            : {
                versionNo: 3,
                inScope: ['ติดตั้งระบบ'],
                outOfScope: ['ย้ายข้อมูลเก่า'],
                deliverables: [
                  { title: 'ระบบพร้อมใช้', criteria: ['ผ่าน UAT'] },
                  { nope: true },
                ],
                assumptions: [],
                feasibility: 'feasible',
                feasibilityNote: '',
                solution: { id: 's-1', title: 'ระบบ ERP' },
              },
        ),
      ),
    } as never,
    {
      on: jest.fn(
        (
          _: string,
          handler: (event: { payload: unknown }) => Promise<void>,
        ) => {
          onSubmitted = handler;
        },
      ),
    } as never,
    { record: jest.fn(() => Promise.resolve()) } as never,
  );
  service.onModuleInit();
  const submit = () => onSubmitted!({ payload: { request_id: 'req-1' } });
  return { service, packages, submit, stored: () => stored };
}

describe('CD-145 the contract request package', () => {
  it("on submit, captures the agreed terms and the approved Solution's scope of work", async () => {
    const { service, submit } = harness({});
    await submit();
    const view = await service.view('req-1', legal);
    expect(view).toMatchObject({
      eligible: true,
      editable: true,
      package: {
        capturedOnSubmit: true,
        negotiationRoundNo: 2,
        tradeTerms: [{ name: 'การชำระเงิน', agreed: 'ภายใน 45 วัน' }],
        solution: { id: 's-1', title: 'ระบบ ERP', versionNo: 3 },
        inScope: ['ติดตั้งระบบ'],
        outOfScope: ['ย้ายข้อมูลเก่า'],
        // a malformed deliverable is dropped, not shown blank
        deliverables: [{ title: 'ระบบพร้อมใช้', criteria: ['ผ่าน UAT'] }],
        missing: [],
      },
    });
  });

  it('says what the deal did not have to capture', async () => {
    const { service, submit } = harness({ round: false, solution: false });
    await submit();
    const view = await service.view('req-1', legal);
    expect(view.package?.missing).toEqual([
      'ดีลนี้ยังไม่มีการบันทึกการต่อรองเงื่อนไข',
      'ดีลนี้ยังไม่มี Solution ที่อนุมัติแล้ว',
    ]);
  });

  it('only a contract request raised from a deal; other requests are left alone', async () => {
    const other = harness({ typeCode: 'DSC' });
    await other.submit();
    expect(other.packages.upsert).not.toHaveBeenCalled();
    const fromCustomer = harness({ refType: 'customer' });
    await fromCustomer.submit();
    expect(fromCustomer.packages.upsert).not.toHaveBeenCalled();
  });

  it('Legal captures it again while the request is open — not after', async () => {
    const open = harness({ status: 'in_progress' });
    await open.service.refresh('req-1', legal);
    expect(open.stored()).toMatchObject({ capturedBy: 'u-legal' });
    const closed = harness({ status: 'completed' });
    await expect(closed.service.refresh('req-1', legal)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });
});
