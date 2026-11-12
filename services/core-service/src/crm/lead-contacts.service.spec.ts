import type { Principal } from '@request-management/share';
import { LeadContactsService } from './lead-contacts.service';
import { contactsOf, hasPrimaryContact } from './lead-contact-rules';

/**
 * ผู้ติดต่อของ Lead ได้หลายคน (12 พ.ย. 2569) — ผู้ติดต่อหลักอยู่บน `leads`,
 * คนที่สองเป็นต้นไปอยู่ใน `lead_contacts`.
 */
function principal(): Principal {
  return {
    userId: 'me',
    activeCompanyId: 'osd',
    isServiceAccount: false,
    displayName: 'Me',
  } as unknown as Principal;
}

interface LeadState {
  id: string;
  name: string;
  status: string;
  sourceCode: string | null;
  contactName: string | null;
  contactPosition: string | null;
  phone: string | null;
  email: string | null;
}

interface RowState {
  id: string;
  leadId: string;
  name: string;
  position: string | null;
  phone: string | null;
  email: string | null;
  active: boolean;
}

/** An in-memory lead and its extra contacts, so a test reads the end state. */
function harness(
  options: {
    primary?: Partial<LeadState> | null;
    rows?: Partial<RowState>[];
    requireOpen?: () => Promise<never>;
  } = {},
) {
  const lead: LeadState = {
    id: 'lead-1',
    name: 'บริษัท มุ่งหวัง จำกัด',
    status: 'new',
    sourceCode: 'web',
    contactName: null,
    contactPosition: null,
    phone: null,
    email: null,
    ...(options.primary === null
      ? {}
      : {
          contactName: 'สมชาย ใจดี',
          phone: '0812345678',
          email: 'somchai@example.com',
          ...options.primary,
        }),
  };
  const rows: RowState[] = (options.rows ?? []).map((row, index) => ({
    id: `row-${index + 1}`,
    leadId: lead.id,
    name: `คนที่ ${index + 2}`,
    position: null,
    phone: null,
    email: null,
    active: true,
    ...row,
  }));

  const leadsService = {
    requireOpen: jest.fn(
      options.requireOpen ?? (() => Promise.resolve({ ...lead })),
    ),
  };
  const leads = {
    update: jest.fn(({ data }: { data: Partial<LeadState> }) => {
      Object.assign(lead, data);
      return Promise.resolve(lead);
    }),
    findFirst: jest.fn(() => Promise.resolve({ ...lead })),
  };
  const contacts = {
    create: jest.fn(({ data }: { data: Partial<RowState> }) => {
      const row = {
        id: `row-${rows.length + 1}`,
        position: null,
        phone: null,
        email: null,
        active: true,
        ...data,
      } as RowState;
      rows.push(row);
      return Promise.resolve(row);
    }),
    update: jest.fn(
      ({ where, data }: { where: { id: string }; data: Partial<RowState> }) => {
        const row = rows.find((candidate) => candidate.id === where.id)!;
        Object.assign(row, data);
        return Promise.resolve(row);
      },
    ),
    findFirst: jest.fn(
      ({ where }: { where: { id?: string; leadId: string } }) =>
        Promise.resolve(
          rows.find(
            (row) =>
              row.active &&
              row.leadId === where.leadId &&
              (!where.id || row.id === where.id),
          ) ?? null,
        ),
    ),
    findMany: jest.fn(() => Promise.resolve(rows.filter((row) => row.active))),
  };
  const transactions = {
    execute: jest.fn((work: (prisma: unknown) => Promise<unknown>) => work({})),
  };
  const audit = { record: jest.fn(() => Promise.resolve()) };
  const events = { emit: jest.fn(() => Promise.resolve()) };

  const service = new LeadContactsService(
    leadsService as never,
    leads as never,
    contacts as never,
    transactions as never,
    audit as never,
    events as never,
  );

  return { service, lead, rows, leads, contacts, audit, events };
}

describe('ผู้ติดต่อของ Lead — อ่านเป็นรายการเดียว', () => {
  it('ผู้ติดต่อหลักมาก่อน แล้วตามด้วยคนที่เพิ่มทีหลัง', () => {
    const list = contactsOf(
      {
        contactName: 'สมชาย',
        contactPosition: null,
        phone: null,
        email: null,
      },
      [
        {
          id: 'row-1',
          name: 'สมหญิง',
          position: null,
          phone: null,
          email: null,
        },
      ],
    );

    expect(list.map((contact) => [contact.id, contact.isPrimary])).toEqual([
      ['primary', true],
      ['row-1', false],
    ]);
  });

  it('Lead ที่มีแค่อีเมล ก็นับว่ามีผู้ติดต่อหลัก; ว่างทั้งหมด = ไม่มี', () => {
    const blank = {
      contactName: null,
      contactPosition: null,
      phone: null,
      email: null,
    };

    expect(hasPrimaryContact({ ...blank, email: 'a@b.co' })).toBe(true);
    expect(hasPrimaryContact({ ...blank, contactName: '  ' })).toBe(false);
    expect(contactsOf(blank, [])).toEqual([]);
  });
});

describe('LeadContactsService — เพิ่ม', () => {
  it('เพิ่มคนที่สอง: ผู้ติดต่อหลักบน Lead ไม่ถูกแตะ', async () => {
    const { service, lead, leads, audit, events } = harness();

    const list = await service.add(
      'lead-1',
      { name: ' สมหญิง รักดี ', phone: '0899999999' },
      principal(),
    );

    expect(leads.update).not.toHaveBeenCalled();
    expect(lead.contactName).toBe('สมชาย ใจดี');
    expect(list).toEqual([
      expect.objectContaining({ id: 'primary', name: 'สมชาย ใจดี' }),
      expect.objectContaining({
        name: 'สมหญิง รักดี',
        phone: '0899999999',
        isPrimary: false,
      }),
    ]);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'crm.lead.contact_added',
        resourceId: 'lead-1',
        // ชื่อเท่านั้น — เบอร์และอีเมลไม่ลง audit
        after: { name: 'สมหญิง รักดี', isPrimary: false },
      }),
      expect.anything(),
    );
    expect(events.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'lead.updated',
        payload: expect.objectContaining({ changed_fields: ['contacts'] }),
      }),
    );
  });

  it('Lead ที่ยังไม่มีผู้ติดต่อ: คนแรกเป็นผู้ติดต่อหลักบน Lead ไม่ใช่แถวใหม่', async () => {
    const { service, lead, rows } = harness({ primary: null });

    const list = await service.add(
      'lead-1',
      { name: 'สมหญิง', email: 'ying@example.com' },
      principal(),
    );

    expect(rows).toHaveLength(0);
    expect(lead).toEqual(
      expect.objectContaining({
        contactName: 'สมหญิง',
        email: 'ying@example.com',
        phone: null,
      }),
    );
    expect(list).toEqual([
      expect.objectContaining({ id: 'primary', isPrimary: true }),
    ]);
  });

  it('is_primary: คนใหม่ขึ้นเป็นหลัก คนเดิมลงมาเป็นผู้ติดต่อเพิ่มเติมครบทุกค่า', async () => {
    const { service, lead, rows } = harness({
      primary: { contactPosition: 'ผู้จัดการ' },
    });

    await service.add(
      'lead-1',
      { name: 'สมหญิง', is_primary: true },
      principal(),
    );

    expect(lead).toEqual(
      expect.objectContaining({
        contactName: 'สมหญิง',
        contactPosition: null,
        phone: null,
        email: null,
      }),
    );
    expect(rows).toEqual([
      expect.objectContaining({
        name: 'สมชาย ใจดี',
        position: 'ผู้จัดการ',
        phone: '0812345678',
        email: 'somchai@example.com',
      }),
    ]);
  });

  it('Lead ที่ปิดแล้ว/มองไม่เห็น: ไม่เขียนอะไรเลย', async () => {
    const { service, leads, contacts } = harness({
      requireOpen: () => Promise.reject(new Error('NOT_FOUND')),
    });

    await expect(
      service.add('lead-1', { name: 'สมหญิง' }, principal()),
    ).rejects.toThrow('NOT_FOUND');
    expect(leads.update).not.toHaveBeenCalled();
    expect(contacts.create).not.toHaveBeenCalled();
  });
});

describe('LeadContactsService — แก้และตั้งผู้ติดต่อหลัก', () => {
  it('แก้ผู้ติดต่อหลัก (`primary`) = เขียนสี่คอลัมน์บน Lead', async () => {
    const { service, lead } = harness();

    await service.update(
      'lead-1',
      'primary',
      { name: 'สมชาย ใจดีมาก', position: 'กรรมการ' },
      principal(),
    );

    // เขียนทั้งชุด: เบอร์/อีเมลที่ไม่ส่งมา = ว่าง
    expect(lead).toEqual(
      expect.objectContaining({
        contactName: 'สมชาย ใจดีมาก',
        contactPosition: 'กรรมการ',
        phone: null,
        email: null,
      }),
    );
  });

  it('ตั้งคนที่สองเป็นหลัก = สลับค่ากัน จำนวนคนเท่าเดิม', async () => {
    const { service, lead, rows } = harness({
      rows: [{ name: 'สมหญิง', email: 'ying@example.com' }],
    });

    const list = await service.update(
      'lead-1',
      'row-1',
      { name: 'สมหญิง', email: 'ying@example.com', is_primary: true },
      principal(),
    );

    expect(lead).toEqual(
      expect.objectContaining({
        contactName: 'สมหญิง',
        email: 'ying@example.com',
        phone: null,
      }),
    );
    expect(rows[0]).toEqual(
      expect.objectContaining({
        name: 'สมชาย ใจดี',
        phone: '0812345678',
        email: 'somchai@example.com',
        active: true,
      }),
    );
    expect(list).toHaveLength(2);
  });

  it('ผู้ติดต่อของ Lead ใบอื่น หรือที่ลบไปแล้ว → 404', async () => {
    const { service } = harness({ rows: [{ active: false }] });

    await expect(
      service.update('lead-1', 'row-1', { name: 'ใครก็ได้' }, principal()),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      service.remove('lead-1', 'no-such-row', principal()),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('LeadContactsService — ลบ', () => {
  it('ลบผู้ติดต่อเพิ่มเติม = soft delete แถวยังอยู่', async () => {
    const { service, rows, lead } = harness({ rows: [{ name: 'สมหญิง' }] });

    const list = await service.remove('lead-1', 'row-1', principal());

    expect(rows[0].active).toBe(false);
    expect(lead.contactName).toBe('สมชาย ใจดี');
    expect(list).toHaveLength(1);
  });

  it('ลบผู้ติดต่อหลัก: คนที่เพิ่มไว้ก่อนสุดขึ้นมาเป็นหลักแทน', async () => {
    const { service, rows, lead } = harness({
      rows: [{ name: 'สมหญิง', phone: '0899999999' }, { name: 'สมศักดิ์' }],
    });

    const list = await service.remove('lead-1', 'primary', principal());

    expect(lead).toEqual(
      expect.objectContaining({
        contactName: 'สมหญิง',
        phone: '0899999999',
        email: null,
      }),
    );
    expect(rows[0].active).toBe(false);
    expect(list.map((contact) => contact.name)).toEqual(['สมหญิง', 'สมศักดิ์']);
  });

  it('ลบผู้ติดต่อหลักที่เป็นคนเดียว: Lead ไม่มีผู้ติดต่อเหลือ', async () => {
    const { service, lead } = harness();

    const list = await service.remove('lead-1', 'primary', principal());

    expect(lead).toEqual(
      expect.objectContaining({ contactName: null, phone: null, email: null }),
    );
    expect(list).toEqual([]);
  });
});
