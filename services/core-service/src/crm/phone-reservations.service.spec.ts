import { AppError, type Principal } from '@request-management/share';
import { MockReservePhoneClient } from '../reserve-phone/mock-reserve-phone.client';
import { formatPhoneNumber } from '../notifications/notifications.service';
import { PhoneReservationsService } from './phone-reservations.service';

const DAY = 86_400_000;

const me = {
  userId: 'sales-1',
  activeCompanyId: 'osd',
  displayName: 'ฝ่ายขาย',
  permissions: ['crm.sales.manage', 'crm.sales.read'],
} as unknown as Principal;

type Row = Record<string, unknown> & {
  id: string;
  opportunityId: string;
  status: string;
  expiresAt: Date;
  expiryWarnedFor: Date | null;
};

interface DealRow {
  id: string;
  companyId: string;
  opportunityCode: string;
  title: string;
  stage: string;
  ownerUserId: string;
}

/** Just enough of Prisma's `where` for what the service asks. */
function matches(
  row: Row,
  where: Record<string, unknown>,
  deals: Map<string, DealRow>,
): boolean {
  return Object.entries(where).every(([key, want]) => {
    if (key === 'opportunity') {
      const stage = deals.get(row.opportunityId)?.stage;
      const cond = (want as { stage: unknown }).stage;
      if (typeof cond === 'string') return stage === cond;
      return !(cond as { notIn: string[] }).notIn.includes(stage as string);
    }
    const value = row[key];
    if (want instanceof Date || want === null) {
      return (value as Date | null)?.getTime?.() === want?.getTime?.();
    }
    if (typeof want === 'object') {
      const range = want as { lte?: Date; gt?: Date };
      const at = (value as Date).getTime();
      return (
        (!range.lte || at <= range.lte.getTime()) &&
        (!range.gt || at > range.gt.getTime())
      );
    }
    return value === want;
  });
}

function harness(
  options: {
    stage?: string;
    createFails?: 'unique';
    clientDown?: boolean;
    ruleEnabled?: boolean;
  } = {},
) {
  const deals = new Map<string, DealRow>([
    [
      'opp-1',
      {
        id: 'opp-1',
        companyId: 'osd',
        opportunityCode: 'OPP-OSD-0001',
        title: 'ระบบโทรศัพท์',
        stage: options.stage ?? 'proposing',
        ownerUserId: 'owner-1',
      },
    ],
    [
      'opp-2',
      {
        id: 'opp-2',
        companyId: 'osd',
        opportunityCode: 'OPP-OSD-0002',
        title: 'ดีลอื่น',
        stage: 'proposing',
        ownerUserId: 'owner-2',
      },
    ],
  ]);
  const rows: Row[] = [];
  const withDeal = (row: Row, include?: unknown) =>
    include ? { ...row, opportunity: deals.get(row.opportunityId) } : row;
  const reservations = {
    findFirst: jest.fn(
      (args: { where: Record<string, unknown>; select?: unknown }) => {
        const row = rows.find((r) => matches(r, args.where, deals));
        return Promise.resolve(row ? withDeal(row, args.select) : null);
      },
    ),
    findMany: jest.fn(
      (args: { where: Record<string, unknown>; include?: unknown }) =>
        Promise.resolve(
          rows
            .filter((r) => matches(r, args.where, deals))
            .map((r) => withDeal(r, args.include)),
        ),
    ),
    create: jest.fn((args: { data: Record<string, unknown> }) => {
      if (options.createFails === 'unique') {
        return Promise.reject(
          Object.assign(new Error('dup'), { code: 'P2002' }),
        );
      }
      const row = {
        id: `res-${rows.length + 1}`,
        expiryWarnedFor: null,
        status: 'reserved',
        ...args.data,
      } as Row;
      rows.push(row);
      return Promise.resolve(row);
    }),
    update: jest.fn(
      (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = rows.find((r) => r.id === args.where.id) as Row;
        Object.assign(row, args.data);
        return Promise.resolve(row);
      },
    ),
    updateMany: jest.fn(
      (args: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        const hit = rows.filter((r) => matches(r, args.where, deals));
        hit.forEach((r) => Object.assign(r, args.data));
        return Promise.resolve({ count: hit.length });
      },
    ),
  };
  const client = new MockReservePhoneClient();
  if (options.clientDown) {
    jest.spyOn(client, 'reserve').mockRejectedValue(new Error('ECONNREFUSED'));
  }
  const releaseSpy = jest.spyOn(client, 'release');
  const notifications = {
    phoneReservationExpiry: jest.fn(() => Promise.resolve()),
  };
  const rule = {
    enabled: options.ruleEnabled ?? true,
    params: { warn_days: 3 },
  };
  const service = new PhoneReservationsService(
    {
      findFirst: jest.fn((args: { where: { id: string } }) =>
        Promise.resolve(deals.get(args.where.id) ?? null),
      ),
    } as never,
    reservations as never,
    { findFirst: jest.fn(() => Promise.resolve({ code: 'OSD' })) } as never,
    { findMany: jest.fn(() => Promise.resolve([])) } as never,
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
    { record: jest.fn(() => Promise.resolve()) } as never,
    {
      get: jest.fn(
        (key: string) =>
          ({ 'reservePhone.holdDays': 14, 'reservePhone.maxHoldDays': 60 })[
            key
          ],
      ),
    } as never,
    client,
  );
  return { service, rows, deals, client, releaseSpy, notifications };
}

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    return (error as AppError).code;
  }
  return 'no error';
}

describe('CD-78 MockReservePhoneClient', () => {
  it('searches free numbers and hides held ones until the hold lapses', async () => {
    const client = new MockReservePhoneClient();
    const ctx = { companyCode: 'OSD' };
    const golden = await client.search(ctx, { category: 'golden', limit: 10 });
    expect(golden.map((n) => n.number)).toContain('021008888');
    expect(golden.every((n) => n.fee === 5000)).toBe(true);

    const soon = new Date(Date.now() + 50).toISOString();
    await client.reserve(ctx, '021008888', { reference: 'X', expiresAt: soon });
    const after = await client.search(ctx, { contains: '8888', limit: 10 });
    expect(after.map((n) => n.number)).not.toContain('021008888');
    // another company's pool is its own
    const other = await client.search(
      { companyCode: 'OSDD' },
      { contains: '8888', limit: 10 },
    );
    expect(other.map((n) => n.number)).toContain('021008888');

    await new Promise((resolve) => setTimeout(resolve, 60));
    const lapsed = await client.search(ctx, { contains: '8888', limit: 10 });
    expect(lapsed.map((n) => n.number)).toContain('021008888');
  });

  it('formats numbers the way people read them', () => {
    expect(formatPhoneNumber('021008888')).toBe('02-100-8888');
    expect(formatPhoneNumber('0861234567')).toBe('086-123-4567');
    expect(formatPhoneNumber('1234')).toBe('1234');
  });
});

describe('CD-78 PhoneReservationsService', () => {
  it('holds each number for the deal; one already held elsewhere is reported, the rest still held', async () => {
    const { service, rows } = harness();
    const first = await service.reserve(
      'opp-2',
      { numbers: ['021005555'] },
      me,
    );
    expect(first.failed).toEqual([]);

    const result = await service.reserve(
      'opp-1',
      { numbers: ['021008888', '021005555', '999999999', '021008888'] },
      me,
    );
    expect(result.reserved.map((r) => r.number)).toEqual(['021008888']);
    expect(result.failed).toEqual([
      { number: '021005555', reason: 'จองไว้แล้วให้ OPP-OSD-0002' },
      { number: '999999999', reason: 'เบอร์นี้ไม่ว่างแล้ว' },
    ]);
    const held = rows.find((r) => r.number === '021008888') as Row;
    // default hold — 14 days
    expect(Math.round((held.expiresAt.getTime() - Date.now()) / DAY)).toBe(14);
    expect(held.fee).toBe(5000);
  });

  it('refuses a hold longer than the maximum and any change on a closed deal', async () => {
    expect(
      await codeOf(
        harness().service.reserve(
          'opp-1',
          { numbers: ['021008888'], hold_days: 90 },
          me,
        ),
      ),
    ).toBe('VALIDATION_FAILED');
    expect(
      await codeOf(
        harness({ stage: 'won' }).service.reserve(
          'opp-1',
          { numbers: ['021008888'] },
          me,
        ),
      ),
    ).toBe('CONFLICT');
  });

  it('a hold the database cannot record is handed straight back to Reserve-phone', async () => {
    const { service, releaseSpy } = harness({ createFails: 'unique' });
    const result = await service.reserve(
      'opp-1',
      { numbers: ['021008888'] },
      me,
    );
    expect(result.reserved).toEqual([]);
    expect(result.failed).toEqual([
      { number: '021008888', reason: 'จองไว้แล้วให้ดีลอื่น' },
    ]);
    expect(releaseSpy).toHaveBeenCalledTimes(1);
  });

  it('Reserve-phone down answers UPSTREAM_ERROR, not a half-done page', async () => {
    expect(
      await codeOf(
        harness({ clientDown: true }).service.reserve(
          'opp-1',
          { numbers: ['021008888'] },
          me,
        ),
      ),
    ).toBe('UPSTREAM_ERROR');
  });

  it('extends from today and re-arms the warning; release frees the number, even on a won deal', async () => {
    const h = harness();
    const { reserved } = await h.service.reserve(
      'opp-1',
      { numbers: ['021008888'], hold_days: 2 },
      me,
    );
    const row = h.rows[0];
    row.expiryWarnedFor = row.expiresAt;
    await h.service.extend('opp-1', reserved[0].id, { hold_days: 30 }, me);
    expect(Math.round((row.expiresAt.getTime() - Date.now()) / DAY)).toBe(30);
    expect(row.expiryWarnedFor).toBeNull();

    (h.deals.get('opp-1') as DealRow).stage = 'won';
    await h.service.release('opp-1', reserved[0].id, me);
    expect(row).toMatchObject({
      status: 'released',
      releasedBy: 'sales-1',
      releaseReason: 'manual',
    });
    expect(await codeOf(h.service.release('opp-1', reserved[0].id, me))).toBe(
      'CONFLICT',
    );
  });

  it('the sweep releases a lost deal, expires lapsed holds, and warns once before', async () => {
    const h = harness();
    await h.service.reserve(
      'opp-1',
      { numbers: ['021008888', '021009999', '021005555'] },
      me,
    );
    await h.service.reserve('opp-2', { numbers: ['021001234'] }, me);
    const [lapsed, soon, later] = h.rows;
    const now = new Date();
    lapsed.expiresAt = new Date(now.getTime() - 1000);
    soon.expiresAt = new Date(now.getTime() + 2 * DAY);
    later.expiresAt = new Date(now.getTime() + 10 * DAY);
    (h.deals.get('opp-2') as DealRow).stage = 'lost';

    expect(await h.service.sweep(now)).toEqual({
      released: 1,
      expired: 1,
      warned: 1,
    });
    expect(h.rows[3]).toMatchObject({
      status: 'released',
      releaseReason: 'deal_lost',
    });
    expect(lapsed.status).toBe('expired');
    expect(later.status).toBe('reserved');
    expect(h.notifications.phoneReservationExpiry.mock.calls).toEqual([
      [
        'owner-1',
        'osd',
        expect.objectContaining({ opportunityCode: 'OPP-OSD-0001' }),
        expect.objectContaining({ number: '021008888' }),
        true,
      ],
      [
        'owner-1',
        'osd',
        expect.objectContaining({ opportunityCode: 'OPP-OSD-0001' }),
        expect.objectContaining({ number: '021009999' }),
        false,
      ],
    ]);

    // a second tick tells nobody twice
    expect(await h.service.sweep(now)).toEqual({
      released: 0,
      expired: 0,
      warned: 0,
    });
  });

  it('a company that turned the rule off still expires holds, silently', async () => {
    const h = harness({ ruleEnabled: false });
    await h.service.reserve('opp-1', { numbers: ['021008888'] }, me);
    h.rows[0].expiresAt = new Date(Date.now() - 1000);
    expect(await h.service.sweep()).toMatchObject({ expired: 1, warned: 0 });
    expect(h.notifications.phoneReservationExpiry).not.toHaveBeenCalled();
  });
});
