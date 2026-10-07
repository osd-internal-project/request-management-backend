import type { Principal } from '@request-management/share';
import { CampaignEventsService } from './campaign-events.service';
import { CampaignRegistrationWriter } from './campaign-registration.writer';

const actor = {
  userId: 'u-mkt',
  activeCompanyId: 'osd',
  permissions: ['crm.campaign.manage'],
} as unknown as Principal;

const event = {
  id: 'cmp-ev',
  companyId: 'osd',
  code: 'SEMINAR',
  name: 'สัมมนา Smart Building',
  kind: 'event',
  eventStartsAt: new Date('2026-10-20T02:00:00Z'),
  eventEndsAt: new Date('2026-10-20T08:00:00Z'),
  eventVenue: 'Ballroom',
  eventOnlineUrl: null,
  eventCapacity: 2,
};

const reg = (overrides: Record<string, unknown> = {}) => ({
  id: 'reg-1',
  companyId: 'osd',
  campaignId: 'cmp-ev',
  company: 'บจก. ตัวอย่าง',
  contactName: 'สมชาย',
  position: null,
  phone: '0812345678',
  email: 'somchai@example.com',
  need: 'กล้อง 40 จุด',
  status: 'registered',
  walkIn: false,
  attendedAt: new Date('2026-10-20T03:00:00Z'),
  interest: 'interested',
  followNote: 'ขอใบเสนอราคา',
  leadId: null,
  leadOutcome: null,
  convertedAt: null,
  createdAt: new Date('2026-10-01T00:00:00Z'),
  ...overrides,
});

describe('CD-270 registration writer', () => {
  function writer(rows: unknown[] = [], seated = 0) {
    const repo = {
      findMany: jest.fn(() => Promise.resolve(rows)),
      count: jest.fn(() => Promise.resolve(seated)),
      create: jest.fn(() => Promise.resolve({ id: 'reg-new' })),
      update: jest.fn(() => Promise.resolve({})),
    };
    return { writer: new CampaignRegistrationWriter(repo as never), repo };
  }
  const input = {
    contactName: 'สมชาย',
    company: null,
    position: null,
    phone: '081-234-5678',
    email: null,
    need: null,
  };

  it('a seat while there is one, then the waitlist', async () => {
    const free = writer([], 1);
    await expect(free.writer.register(event, input)).resolves.toEqual({
      id: 'reg-new',
      status: 'registered',
      repeat: false,
    });
    const full = writer([], 2);
    await expect(full.writer.register(event, input)).resolves.toMatchObject({
      status: 'waitlisted',
    });
  });

  it('the same person again gets their registration back', async () => {
    const { writer: w, repo } = writer([
      { id: 'reg-old', status: 'waitlisted', email: null, phone: '0812345678' },
    ]);
    await expect(w.register(event, input)).resolves.toEqual({
      id: 'reg-old',
      status: 'waitlisted',
      repeat: true,
    });
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('a walk-in is in the room: seated and checked in, even when full', async () => {
    const { writer: w, repo } = writer([], 2);
    await w.register(event, input, { walkIn: true, actorId: 'u-mkt' });
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'registered',
          walkIn: true,
          attendedBy: 'u-mkt',
        }),
      }),
    );
  });
});

describe('CD-270 events after the form', () => {
  function harness(rows: unknown[] = [reg()], found: unknown = event) {
    const campaigns = { findFirst: jest.fn(() => Promise.resolve(found)) };
    const registrations = {
      findMany: jest.fn(() => Promise.resolve(rows)),
      findFirst: jest.fn(() => Promise.resolve(rows[0] ?? null)),
      update: jest.fn(() => Promise.resolve({})),
    };
    const writer = { register: jest.fn() };
    const intake = {
      receive: jest.fn(() =>
        Promise.resolve({ outcome: 'created', lead: { id: 'lead-9' } }),
      ),
    };
    const audit = { record: jest.fn(() => Promise.resolve()) };
    const service = new CampaignEventsService(
      campaigns as never,
      registrations as never,
      writer as never,
      intake as never,
      audit as never,
    );
    return { service, registrations, intake };
  }

  it('turns the interested attendees into Leads, with the event as context', async () => {
    const { service, intake, registrations } = harness([
      reg(),
      reg({ id: 'reg-2', interest: 'later' }),
      reg({ id: 'reg-3', attendedAt: null }),
    ]);

    const result = await service.convert(actor, 'cmp-ev', {});

    expect(result).toMatchObject({ converted: 1, created: 1, failed: [] });
    expect(intake.receive).toHaveBeenCalledTimes(1);
    expect(intake.receive).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'บจก. ตัวอย่าง',
        contact_name: 'สมชาย',
        campaign_code: 'SEMINAR',
        source_code: 'event',
        note: 'เข้าร่วม สัมมนา Smart Building (2026-10-20)\nความต้องการ: กล้อง 40 จุด\nหมายเหตุหลังงาน: ขอใบเสนอราคา',
      }),
      actor,
    );
    expect(registrations.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'reg-1' },
        data: expect.objectContaining({
          leadId: 'lead-9',
          leadOutcome: 'created',
        }),
      }),
    );
  });

  it('one failure is reported; the rest still convert', async () => {
    const { service, intake } = harness([reg(), reg({ id: 'reg-2' })]);
    intake.receive.mockRejectedValueOnce(new Error('ไม่พบแคมเปญ'));

    const result = await service.convert(actor, 'cmp-ev', {});

    expect(result.converted).toBe(1);
    expect(result.failed).toEqual([{ id: 'reg-1', reason: 'ไม่พบแคมเปญ' }]);
  });

  it('a waitlisted person who turns up has a seat after all', async () => {
    const { service, registrations } = harness([
      reg({ status: 'waitlisted', attendedAt: null }),
    ]);

    await service.checkIn(actor, 'reg-1', true);

    expect(registrations.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'registered' }),
      }),
    );
  });

  it('a Lead already made cannot be un-attended or cancelled', async () => {
    const { service } = harness([reg({ leadId: 'lead-1' })]);
    await expect(service.checkIn(actor, 'reg-1', false)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await expect(
      service.setStatus(actor, 'reg-1', { status: 'cancelled' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('SCOPE-03 and kind: another company is 404, a plain campaign is refused', async () => {
    await expect(
      harness([], null).service.list(actor, 'x'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      harness([], { ...event, kind: 'campaign' }).service.list(actor, 'x'),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('the list counts the event and marks who can convert', async () => {
    const view = await harness([
      reg(),
      reg({ id: 'r2', status: 'waitlisted', attendedAt: null, interest: null }),
    ]).service.list(actor, 'cmp-ev');
    expect(view.counts).toMatchObject({
      registered: 1,
      waitlisted: 1,
      attended: 1,
      interested: 1,
    });
    expect(view.registrations.map((row) => row.convertible)).toEqual([
      true,
      false,
    ]);
  });
});
