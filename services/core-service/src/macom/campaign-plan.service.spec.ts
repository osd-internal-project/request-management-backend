import { Prisma } from '@prisma/client';
import { AppError } from '@request-management/share';
import type { Principal } from '@request-management/share';
import { CampaignPlanService } from './campaign-plan.service';

const actor = {
  userId: 'u-mkt',
  activeCompanyId: 'company-osd',
  permissions: ['crm.campaign.manage'],
} as unknown as Principal;

const campaign = {
  id: 'cmp-1',
  companyId: 'company-osd',
  code: 'EXPO',
  name: 'งานอีเวนต์',
  active: true,
  budget: new Prisma.Decimal(100_000),
};

function harness(
  options: {
    lines?: unknown[];
    spends?: unknown[];
    usedSpend?: unknown;
    lineFound?: unknown;
  } = {},
) {
  const tx = {
    campaignSpend: {
      create: jest.fn(() => Promise.resolve({ id: 'sp-new' })),
      update: jest.fn(() => Promise.resolve({})),
      updateMany: jest.fn(() => Promise.resolve({})),
    },
    campaignBudgetLine: {
      create: jest.fn(() => Promise.resolve({})),
      update: jest.fn(() => Promise.resolve({})),
      deleteMany: jest.fn(() => Promise.resolve({})),
    },
    campaign: { update: jest.fn(() => Promise.resolve({})) },
  };
  const campaigns = {
    findFirst: jest.fn((args: { where: { companyId: string } }) =>
      Promise.resolve(args.where.companyId === 'company-osd' ? campaign : null),
    ),
  };
  const lines = {
    findMany: jest.fn(() => Promise.resolve(options.lines ?? [])),
    findFirst: jest.fn(() => Promise.resolve(options.lineFound ?? null)),
  };
  const spends = {
    findMany: jest.fn(() => Promise.resolve(options.spends ?? [])),
    findFirst: jest.fn(() => Promise.resolve(options.usedSpend ?? null)),
  };
  const people = {
    findMany: jest.fn(() =>
      Promise.resolve([{ id: 'u-mkt', displayName: 'ฝ่ายการตลาด' }]),
    ),
  };
  const transactions = {
    execute: jest.fn((fn: (prisma: unknown) => unknown) => fn(tx)),
  };
  const audit = { record: jest.fn(() => Promise.resolve()) };
  const service = new CampaignPlanService(
    campaigns as never,
    lines as never,
    spends as never,
    people as never,
    transactions as never,
    audit as never,
  );
  return { service, tx, audit };
}

const line = (id: string, channel: string, planned: number) => ({
  id,
  channel,
  planned: new Prisma.Decimal(planned),
  note: null,
  sortOrder: 0,
});

const spend = (overrides: Record<string, unknown>) => ({
  id: 'sp-1',
  companyId: 'company-osd',
  campaignId: 'cmp-1',
  budgetLineId: 'fb',
  spentOn: new Date('2026-10-02T00:00:00Z'),
  amount: new Prisma.Decimal(30_000),
  vendor: null,
  note: null,
  receiptKey: null,
  receiptName: null,
  receiptType: null,
  voidedAt: null,
  voidedBy: null,
  voidReason: null,
  createdAt: new Date('2026-10-02T03:00:00Z'),
  createdBy: 'u-mkt',
  ...overrides,
});

describe('CD-268 campaign plan', () => {
  it('shows plan per channel against spend, with who recorded it', async () => {
    const { service } = harness({
      lines: [line('fb', 'Facebook', 20_000), line('expo', 'บูธ', 80_000)],
      spends: [
        spend({}),
        spend({
          id: 'sp-2',
          amount: new Prisma.Decimal(5_000),
          voidedAt: new Date(),
        }),
        spend({
          id: 'sp-3',
          budgetLineId: null,
          amount: new Prisma.Decimal(1_000),
        }),
      ],
    });

    const plan = await service.plan(actor, 'cmp-1');

    expect(plan).toMatchObject({
      planned_total: 100_000,
      spent_total: 31_000,
      remaining: 69_000,
      over_budget: false,
      unassigned_spent: 1_000,
    });
    expect(plan.lines[0]).toMatchObject({
      channel: 'Facebook',
      spent: 30_000,
      over_budget: true,
    });
    expect(plan.spends[0]).toMatchObject({
      budget_line: { id: 'fb', channel: 'Facebook' },
      created_by: 'ฝ่ายการตลาด',
    });
  });

  it('SCOPE-03: another company’s campaign answers 404', async () => {
    const { service } = harness();
    await expect(
      service.plan(
        { ...actor, activeCompanyId: 'company-other' } as Principal,
        'cmp-1',
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('saving lines writes the campaign budget as their sum', async () => {
    const { service, tx, audit } = harness({
      lines: [line('fb', 'Facebook', 20_000)],
    });

    await service.saveLines(actor, 'cmp-1', {
      lines: [
        { id: 'fb', channel: 'Facebook', planned: 25_000 },
        { channel: 'บูธ', planned: 60_000.5 },
      ],
    });

    expect(tx.campaignBudgetLine.update).toHaveBeenCalledTimes(1);
    expect(tx.campaignBudgetLine.create).toHaveBeenCalledTimes(1);
    expect(tx.campaign.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ budget: 85_000.5 }),
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'macom.campaign.budget_saved' }),
      expect.anything(),
    );
  });

  it('a line with spend cannot be dropped', async () => {
    const { service, tx } = harness({
      lines: [line('fb', 'Facebook', 20_000)],
      usedSpend: { budgetLineId: 'fb' },
    });

    await expect(
      service.saveLines(actor, 'cmp-1', { lines: [] }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(tx.campaignBudgetLine.deleteMany).not.toHaveBeenCalled();
  });

  it('removing every line hands the budget back to the campaign form', async () => {
    const { service, tx } = harness({
      lines: [line('fb', 'Facebook', 20_000)],
    });

    await service.saveLines(actor, 'cmp-1', { lines: [] });

    expect(tx.campaign.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ budget: null }),
      }),
    );
  });

  it('spend needs a line of this campaign when one is named', async () => {
    const { service, tx } = harness();

    await expect(
      service.addSpend(actor, 'cmp-1', {
        spent_on: '2026-10-01',
        amount: 100,
        budget_line_id: 'other-campaign-line',
      }),
    ).rejects.toBeInstanceOf(AppError);
    expect(tx.campaignSpend.create).not.toHaveBeenCalled();
  });

  it('a spend is voided with a reason, once', async () => {
    const { service, tx } = harness({ usedSpend: spend({}) });

    await service.voidSpend(actor, 'sp-1', { reason: ' บันทึกซ้ำ ' });
    expect(tx.campaignSpend.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ voidReason: 'บันทึกซ้ำ' }),
      }),
    );

    const again = harness({ usedSpend: spend({ voidedAt: new Date() }) });
    await expect(
      again.service.voidSpend(actor, 'sp-1', { reason: 'x' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
