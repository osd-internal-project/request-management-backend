import type { Principal } from '@request-management/share';
import { ContractExpiryService, stepsReached } from './contract-expiry.service';
import {
  ContractObligationsService,
  obligationNotice,
} from './contract-obligations.service';

const day = (value: string) => new Date(`${value}T00:00:00Z`);
const TODAY = day('2026-10-01');

describe('CD-162 which expiry notices are due', () => {
  it('each warning day once, and the day it ends', () => {
    expect(stepsReached(45, [60, 30, 7], [])).toEqual([60]);
    expect(stepsReached(29, [60, 30, 7], [60])).toEqual([30]);
    // several crossed at once (a contract recorded late): one notice for all
    expect(stepsReached(5, [60, 30, 7], [])).toEqual([60, 30, 7]);
    expect(stepsReached(0, [60, 30, 7], [60, 30, 7])).toEqual([0]);
    expect(stepsReached(29, [60, 30, 7], [60, 30])).toEqual([]);
  });
});

describe('CD-163 obligation reminders', () => {
  const open = {
    status: 'open',
    dueOn: day('2026-10-03'),
    warnedFor: null,
    overdueFor: null,
  };

  it('warns within the window once per due date, then once when overdue', () => {
    expect(obligationNotice(open, TODAY, 3)).toBe('due');
    expect(obligationNotice(open, TODAY, 1)).toBeNull();
    expect(
      obligationNotice({ ...open, warnedFor: day('2026-10-03') }, TODAY, 3),
    ).toBeNull();
    // moved to a new date: warns again
    expect(
      obligationNotice(
        { ...open, dueOn: day('2026-10-02'), warnedFor: day('2026-10-03') },
        TODAY,
        3,
      ),
    ).toBe('due');
    const late = { ...open, dueOn: day('2026-09-30') };
    expect(obligationNotice(late, TODAY, 3)).toBe('overdue');
    expect(
      obligationNotice({ ...late, overdueFor: day('2026-09-30') }, TODAY, 3),
    ).toBeNull();
  });

  it('nothing for a done or undated obligation', () => {
    expect(obligationNotice({ ...open, status: 'done' }, TODAY, 3)).toBeNull();
    expect(obligationNotice({ ...open, dueOn: null }, TODAY, 3)).toBeNull();
  });
});

function obligationsHarness(row: Record<string, unknown> | null) {
  const obligations = {
    findFirst: jest.fn(() => Promise.resolve(row)),
    update: jest.fn((args: { data: Record<string, unknown> }) =>
      Promise.resolve({ ...row, ...args.data }),
    ),
  };
  const service = new ContractObligationsService(
    obligations as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { record: jest.fn(() => Promise.resolve()) } as never,
    { get: () => 0 } as never,
  );
  return { service, obligations };
}

const person = (userId: string, permissions: string[] = []) =>
  ({
    userId,
    activeCompanyId: 'osd',
    permissions,
  }) as unknown as Principal;

describe('CD-163 marking an obligation done', () => {
  const row = {
    id: 'ob-1',
    companyId: 'osd',
    contractId: 'c-1',
    title: 'ส่งรายงาน',
    ownerUserId: 'eng-1',
    status: 'open',
  };

  it('its owner may, Legal may on their behalf; anyone else finds nothing', async () => {
    const owner = obligationsHarness(row);
    await expect(
      owner.service.complete('ob-1', { note: ' ส่งแล้ว ' }, person('eng-1')),
    ).resolves.toMatchObject({
      status: 'done',
      doneBy: 'eng-1',
      doneNote: 'ส่งแล้ว',
    });

    const legal = obligationsHarness(row);
    await expect(
      legal.service.complete(
        'ob-1',
        {},
        person('legal-1', ['legal.contract.manage']),
      ),
    ).resolves.toMatchObject({ status: 'done', doneBy: 'legal-1' });

    const other = obligationsHarness(row);
    await expect(
      other.service.complete('ob-1', {}, person('sales-9')),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(other.obligations.update).not.toHaveBeenCalled();
  });

  it('a closed one cannot be closed again', async () => {
    const done = obligationsHarness({ ...row, status: 'done' });
    await expect(
      done.service.complete('ob-1', {}, person('eng-1')),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

describe('CD-162 ContractExpiryService.sweep', () => {
  it('warns the owner of a contract off the renewal path, once per step', async () => {
    const contract = {
      id: 'nda-1',
      companyId: 'osd',
      contractNo: 'NDA-001',
      title: 'NDA',
      endOn: day('2026-10-31'),
      ownerUserId: 'legal-1',
      remindedDays: [] as number[],
      counterpartyName: 'บริษัท คู่ค้า จำกัด',
      customer: null,
    };
    const contracts = {
      findMany: jest.fn(() => Promise.resolve([contract])),
      updateMany: jest.fn((args: { data: { remindedDays: number[] } }) => {
        contract.remindedDays = args.data.remindedDays;
        return Promise.resolve({ count: 1 });
      }),
    };
    const rule = { enabled: true, params: { warn_days: [60, 30, 7] } };
    const notifications = { contractExpiry: jest.fn(() => Promise.resolve()) };
    const service = new ContractExpiryService(
      contracts as never,
      {
        across: jest.fn(() =>
          Promise.resolve({
            standard: rule,
            byCompany: new Map(),
            of: () => rule,
          }),
        ),
      } as never,
      notifications as never,
      { get: () => 0 } as never,
    );
    // 2026-10-01 07:00 Bangkok → 30 days left
    const now = new Date('2026-10-01T00:00:00Z');
    expect(await service.sweep(now)).toEqual({ warned: 1 });
    expect(contract.remindedDays).toEqual([60, 30]);
    expect(notifications.contractExpiry).toHaveBeenCalledWith(
      'legal-1',
      'osd',
      expect.objectContaining({
        contractNo: 'NDA-001',
        party: 'บริษัท คู่ค้า จำกัด',
        endOn: '2026-10-31',
      }),
      30,
    );
    expect(await service.sweep(now)).toEqual({ warned: 0 });
    // the query keeps customer sale/service contracts and MSAs out
    expect(contracts.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ customerId: null }, { kind: { in: ['nda', 'other'] } }],
        }) as unknown,
      }),
    );
  });
});
