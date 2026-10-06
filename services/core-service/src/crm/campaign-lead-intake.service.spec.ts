import type { Principal } from '@request-management/share';
import { CampaignLeadIntakeService } from './campaign-lead-intake.service';

const robot = {
  userId: 'svc-form',
  activeCompanyId: 'osd',
  isServiceAccount: true,
  permissions: ['integration.crm.lead.create'],
} as unknown as Principal;

const campaign = {
  id: 'cmp-1',
  companyId: 'osd',
  code: 'EXPO',
  name: 'งาน Expo',
  active: true,
  receivingOrgUnitId: 'ou-getter',
  formEnabled: true,
  formIntro: 'ลงทะเบียนรับเอกสาร',
};

const leadRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'lead-new',
  name: 'บจก. ตัวอย่าง',
  status: 'new',
  sourceCode: 'web_form',
  ownerUserId: null,
  createdAt: new Date('2026-10-06T03:00:00Z'),
  ...overrides,
});

function harness(
  options: {
    open?: unknown[];
    customer?: unknown;
    contacts?: unknown[];
    campaignFound?: unknown;
    manager?: string | null;
  } = {},
) {
  const leadsService = {
    create: jest.fn(() => Promise.resolve({ id: 'lead-new' })),
  };
  const leads = {
    findMany: jest.fn(() => Promise.resolve(options.open ?? [])),
    findFirst: jest.fn(() => Promise.resolve(leadRow())),
    update: jest.fn(() => Promise.resolve({})),
  };
  const activities = { create: jest.fn(() => Promise.resolve({})) };
  const campaigns = {
    findFirst: jest.fn(() =>
      Promise.resolve(
        options.campaignFound === undefined ? campaign : options.campaignFound,
      ),
    ),
  };
  const customers = {
    findFirst: jest.fn(() => Promise.resolve(options.customer ?? null)),
  };
  const contacts = {
    findMany: jest.fn(() => Promise.resolve(options.contacts ?? [])),
  };
  const statuses = {
    listAll: jest.fn(() =>
      Promise.resolve([
        { code: 'new', kind: 'open' },
        { code: 'contacted', kind: 'open' },
        { code: 'converted', kind: 'won' },
        { code: 'disqualified', kind: 'lost' },
      ]),
    ),
  };
  const orgUnits = {
    findFirst: jest.fn(() =>
      Promise.resolve({
        managerUserId:
          options.manager === undefined ? 'head-getter' : options.manager,
      }),
    ),
  };
  const notifications = { campaignLead: jest.fn(() => Promise.resolve()) };
  const service = new CampaignLeadIntakeService(
    leadsService as never,
    leads as never,
    activities as never,
    campaigns as never,
    customers as never,
    contacts as never,
    statuses as never,
    orgUnits as never,
    notifications as never,
  );
  return {
    service,
    leadsService,
    leads,
    activities,
    customers,
    notifications,
  };
}

const input = {
  name: 'บจก. ตัวอย่าง',
  contact_name: 'สมชาย',
  phone: '081-234-5678',
  email: 'somchai@example.com',
  campaign_code: 'EXPO',
  source_code: 'web_form',
};

describe('CD-269 one screening for every Lead from outside', () => {
  it('a new Lead lands unowned in the campaign team and the head is told', async () => {
    const { service, leadsService, leads, notifications } = harness();

    const result = await service.receive(input, robot);

    expect(result.outcome).toBe('created');
    expect(leadsService.create).toHaveBeenCalledWith(
      expect.objectContaining({ campaign_code: 'EXPO' }),
      robot,
      { unowned: true },
    );
    expect(leads.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ ownerOrgUnitId: 'ou-getter' }),
      }),
    );
    expect(notifications.campaignLead).toHaveBeenCalledWith(
      'head-getter',
      'osd',
      expect.objectContaining({ kind: 'routed', campaign: 'งาน Expo' }),
    );
  });

  it('the same person within 30 days joins the open Lead — no second Lead', async () => {
    const { service, leadsService, activities, notifications } = harness({
      open: [
        leadRow({
          id: 'lead-old',
          ownerUserId: 'sales-1',
          ownerOrgUnitId: 'ou-getter',
          email: 'other@example.com',
          phone: '+66 81 234 5678',
        }),
      ],
    });

    const result = await service.receive(input, robot);

    expect(result).toMatchObject({
      outcome: 'repeat',
      lead: { id: 'lead-old' },
    });
    expect(leadsService.create).not.toHaveBeenCalled();
    expect(activities.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          leadId: 'lead-old',
          subject: 'ลงทะเบียนซ้ำผ่าน งาน Expo',
        }),
      }),
    );
    expect(notifications.campaignLead).toHaveBeenCalledWith(
      'sales-1',
      'osd',
      expect.objectContaining({ kind: 'repeat' }),
    );
  });

  it('a near match that is not the same person is a new Lead', async () => {
    const { service, leadsService } = harness({
      open: [leadRow({ id: 'lead-old', email: null, phone: '02-999-5678' })],
    });

    await service.receive(input, robot);

    expect(leadsService.create).toHaveBeenCalled();
  });

  it('an existing customer goes straight to the account owner (Keeper)', async () => {
    const { service, leadsService, leads, notifications } = harness({
      contacts: [
        { customerId: 'cus-1', email: 'Somchai@Example.com', phone: null },
      ],
      customer: {
        id: 'cus-1',
        accountOwnerUserId: 'keeper-1',
        ownerOrgUnitId: 'ou-keeper',
      },
    });

    const result = await service.receive(input, robot);

    expect(result.outcome).toBe('customer');
    expect(leadsService.create).toHaveBeenCalledWith(
      expect.objectContaining({ customer_id: 'cus-1' }),
      robot,
      { unowned: true },
    );
    expect(leads.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          ownerUserId: 'keeper-1',
          ownerOrgUnitId: 'ou-keeper',
        }),
      }),
    );
    expect(notifications.campaignLead).toHaveBeenCalledWith(
      'keeper-1',
      'osd',
      expect.objectContaining({ kind: 'customer' }),
    );
  });

  it('a failed notice never loses the Lead', async () => {
    const { service, notifications } = harness();
    notifications.campaignLead.mockRejectedValueOnce(new Error('smtp down'));

    await expect(service.receive(input, robot)).resolves.toMatchObject({
      outcome: 'created',
    });
  });

  it('the public form: only an open campaign with the form on, never another company’s', async () => {
    const { service, leadsService } = harness();

    await expect(service.formOf('tok', undefined)).resolves.toEqual({
      campaign: 'งาน Expo',
      intro: 'ลงทะเบียนรับเอกสาร',
    });
    await expect(
      service.formOf('tok', { companyId: 'other' } as never),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const answer = await service.submitForm(
      'tok',
      { name: 'บจก. ตัวอย่าง', phone: '0812345678' },
      robot,
      { companyId: 'osd', sourceCode: null } as never,
    );
    expect(answer).toEqual({ received: true, outcome: 'created' });
    expect(leadsService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        campaign_code: 'EXPO',
        source_code: 'web_form',
      }),
      expect.objectContaining({ activeCompanyId: 'osd' }),
      { unowned: true },
    );

    const closed = harness({ campaignFound: null });
    await expect(closed.service.formOf('tok', undefined)).rejects.toMatchObject(
      { code: 'NOT_FOUND' },
    );
  });

  it('Lead Ads: the form id picks the campaign; an unmapped form is refused', async () => {
    const { service, leadsService } = harness({
      campaignFound: { code: 'EXPO' },
    });
    const payload = {
      form_id: 'fb-1',
      field_data: [
        { name: 'full_name', values: ['วิภา'] },
        { name: 'email', values: ['wipa@example.com'] },
      ],
    };

    await expect(
      service.receiveAd('facebook', payload, robot, undefined),
    ).resolves.toMatchObject({ outcome: 'created' });
    expect(leadsService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'วิภา',
        campaign_code: 'EXPO',
        source_code: 'facebook-lead-ads',
      }),
      expect.anything(),
      { unowned: true },
    );

    const unmapped = harness({ campaignFound: null });
    await expect(
      unmapped.service.receiveAd('facebook', payload, robot, undefined),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      unmapped.service.receiveAd('tiktok', {}, robot, undefined),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
