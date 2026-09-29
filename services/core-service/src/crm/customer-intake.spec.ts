import type { Principal } from '@request-management/share';
import { CustomerIntakeService } from './customer-intake.service';

const robot = {
  userId: 'svc-webform',
  username: 'webform',
  isServiceAccount: true,
  activeCompanyId: 'osd',
  companies: [],
  permissions: ['integration.request.intake'],
} as unknown as Principal;

const admin = {
  userId: 'admin-1',
  username: 'admin',
  isServiceAccount: false,
  activeCompanyId: 'osd',
  companies: [{ id: 'osd' }],
  permissions: ['admin.request-type.manage'],
} as unknown as Principal;

const webForm = (overrides: Record<string, unknown> = {}) => ({
  id: 'ch-1',
  companyId: 'osd',
  channel: 'web_form',
  enabled: true,
  requesterUserId: 'desk-1',
  typeCodes: ['IT-SUPPORT'],
  slug: 'abc123XYZ',
  title: 'แจ้งปัญหา',
  intro: null,
  updatedAt: new Date(),
  company: { name: 'OSD' },
  ...overrides,
});

function harness(
  options: {
    channel?: Record<string, unknown> | null;
    byTax?: { id: string } | null;
    byEmail?: { customerId: string } | null;
    member?: { id: string } | null;
    offered?: { code: string }[];
  } = {},
) {
  const channels = {
    findFirst: jest.fn(() =>
      Promise.resolve(
        options.channel === undefined ? webForm() : options.channel,
      ),
    ),
    findMany: jest.fn(() => Promise.resolve([])),
    upsert: jest.fn(() => Promise.resolve({})),
  };
  const customers = {
    findFirst: jest.fn(() => Promise.resolve(options.byTax ?? null)),
  };
  const contacts = {
    findFirst: jest.fn(() => Promise.resolve(options.byEmail ?? null)),
  };
  const members = {
    findFirst: jest.fn(() =>
      Promise.resolve(
        options.member === undefined ? { id: 'desk-1' } : options.member,
      ),
    ),
  };
  const requests = {
    createFromChannel: jest.fn(() =>
      Promise.resolve({
        detail: { requestNo: 'REQ-OSD-IT-0001', status: 'submitted' },
        statusToken: 'tok_abcdefghijklmnopqrstuvwxyz',
      }),
    ),
    channelTypes: jest.fn((_c: string, codes: string[]) =>
      Promise.resolve(
        options.offered ?? codes.map((code) => ({ code, fields: [] })),
      ),
    ),
    statusByToken: jest.fn(() => Promise.resolve({ status: 'submitted' })),
  };
  const audit = { record: jest.fn(() => Promise.resolve()) };
  const service = new CustomerIntakeService(
    channels as never,
    customers as never,
    contacts as never,
    members as never,
    requests as never,
    audit as never,
  );
  return { service, channels, customers, contacts, requests, audit };
}

const submission = (overrides: Record<string, unknown> = {}) => ({
  type_code: 'IT-SUPPORT',
  form_data: { detail: 'ปริ้นเตอร์เสีย' },
  contact: {
    name: 'คุณเอ',
    email: 'A@Example.com ',
    tax_id: '0-1055-51234-56-7',
  },
  ...overrides,
});

describe('CD-66 customer intake', () => {
  it('CD-66: a web-form submission is raised for the channel’s staff requester, the customer kept as the contact and matched by tax id', async () => {
    const h = harness({ byTax: { id: 'cus-9' } });
    await expect(
      h.service.submitWebForm(
        'abc123XYZ',
        submission(),
        robot,
        null,
        'Bearer x',
      ),
    ).resolves.toEqual({
      request_no: 'REQ-OSD-IT-0001',
      status: 'submitted',
      status_token: 'tok_abcdefghijklmnopqrstuvwxyz',
      customer_matched: true,
    });
    expect(h.requests.createFromChannel).toHaveBeenCalledWith(
      {
        companyId: 'osd',
        channel: 'web_form',
        typeCode: 'IT-SUPPORT',
        requesterUserId: 'desk-1',
        formData: { detail: 'ปริ้นเตอร์เสีย' },
        contact: {
          name: 'คุณเอ',
          email: 'a@example.com',
          phone: null,
          company: null,
          taxId: '0105551234567',
          lineUserId: null,
        },
        ref: { type: 'customer', id: 'cus-9' },
      },
      robot,
      'Bearer x',
    );
  });

  it('no tax id match → a contact with the same email; nothing → no ref', async () => {
    const byEmail = harness({ byEmail: { customerId: 'cus-3' } });
    await byEmail.service.submitWebForm(
      'abc123XYZ',
      submission({ contact: { name: 'x', email: 'a@example.com' } }),
      robot,
      null,
      'Bearer x',
    );
    expect(
      (
        byEmail.requests.createFromChannel.mock.calls[0] as unknown as [
          { ref: unknown },
        ]
      )[0].ref,
    ).toEqual({ type: 'customer', id: 'cus-3' });

    const none = harness();
    await none.service.submitWebForm(
      'abc123XYZ',
      submission({ contact: { name: 'x', phone: '081' } }),
      robot,
      null,
      'Bearer x',
    );
    expect(
      (
        none.requests.createFromChannel.mock.calls[0] as unknown as [
          { ref: unknown },
        ]
      )[0].ref,
    ).toBeNull();
  });

  it('CD-66: only the types the channel offers, and a way to reach the customer back', async () => {
    const h = harness();
    await expect(
      h.service.submitWebForm(
        'abc123XYZ',
        submission({ type_code: 'HR-LEAVE' }),
        robot,
        null,
        'x',
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      h.service.submitWebForm(
        'abc123XYZ',
        submission({ contact: { name: 'x' } }),
        robot,
        null,
        'x',
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(h.requests.createFromChannel).not.toHaveBeenCalled();
  });

  it('SCOPE-03 a key bound to another company, a closed or unknown form: 404', async () => {
    const other = harness();
    await expect(
      other.service.webForm('abc123XYZ', 'bco'),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const closed = harness({ channel: null });
    await expect(closed.service.webForm('nope', null)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    // the query itself asks for an enabled web form
    expect(closed.channels.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { slug: 'nope', channel: 'web_form', enabled: true },
      }),
    );
  });

  it('a malformed status token is a 404 without touching the database', () => {
    const h = harness();
    expect(() => h.service.status('../etc')).toThrow();
    expect(h.requests.statusByToken).not.toHaveBeenCalled();
  });

  it('CD-66 admin: the requester must be an active member; every type must exist in the company; a web form gets a link', async () => {
    const outsider = harness({ member: null });
    await expect(
      outsider.service.save(
        'web_form',
        { enabled: true, requester_user_id: 'x', type_codes: [] },
        admin,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    const unknownType = harness({ offered: [] });
    await expect(
      unknownType.service.save(
        'web_form',
        { enabled: true, requester_user_id: 'desk-1', type_codes: ['NOPE'] },
        admin,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    const fresh = harness({ channel: null });
    await fresh.service.save(
      'web_form',
      {
        enabled: true,
        requester_user_id: 'desk-1',
        type_codes: ['IT-SUPPORT'],
      },
      admin,
    );
    const args = (
      fresh.channels.upsert.mock.calls[0] as unknown as [
        { create: { slug: string | null } },
      ]
    )[0];
    expect(args.create.slug).toMatch(/^[A-Za-z0-9_-]{12}$/);
    expect(fresh.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'request.intake_channel.saved' }),
    );

    // LINE and AI CARE have no public link
    const line = harness({ channel: null });
    await line.service.save(
      'line',
      {
        enabled: true,
        requester_user_id: 'desk-1',
        type_codes: ['IT-SUPPORT'],
      },
      admin,
    );
    const lineArgs = (
      line.channels.upsert.mock.calls[0] as unknown as [
        { create: { slug: string | null } },
      ]
    )[0];
    expect(lineArgs.create.slug).toBeNull();
  });

  it('new_link replaces the web form’s link; otherwise it stays', async () => {
    const keep = harness();
    await keep.service.save(
      'web_form',
      {
        enabled: true,
        requester_user_id: 'desk-1',
        type_codes: ['IT-SUPPORT'],
      },
      admin,
    );
    const kept = (
      keep.channels.upsert.mock.calls[0] as unknown as [
        { update: { slug: string } },
      ]
    )[0].update.slug;
    expect(kept).toBe('abc123XYZ');

    const fresh = harness();
    await fresh.service.save(
      'web_form',
      {
        enabled: true,
        requester_user_id: 'desk-1',
        type_codes: ['IT-SUPPORT'],
        new_link: true,
      },
      admin,
    );
    const renewed = (
      fresh.channels.upsert.mock.calls[0] as unknown as [
        { update: { slug: string } },
      ]
    )[0].update.slug;
    expect(renewed).not.toBe('abc123XYZ');
  });
});
