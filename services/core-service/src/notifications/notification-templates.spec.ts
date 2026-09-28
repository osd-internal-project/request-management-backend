import type { Principal } from '@request-management/share';
import {
  NOTIFICATION_TEMPLATES,
  emailSignature,
  renderTemplate,
  templateOf,
  templateProblems,
} from './notification-templates';
import { NotificationTemplateAdminService } from './notification-template-admin.service';
import { NotificationsService } from './notifications.service';

describe('CD-54 the standard templates', () => {
  it('every standard template uses only the variables it declares', () => {
    for (const definition of NOTIFICATION_TEMPLATES) {
      expect(
        templateProblems(definition, definition.title, definition.body),
      ).toEqual([]);
    }
  });

  it('renders placeholders, and a missing value renders empty rather than as braces', () => {
    expect(
      renderTemplate('คำขอ {{ request_no }} — {{missing}}!', {
        request_no: 'REQ-1',
      }),
    ).toBe('คำขอ REQ-1 — !');
  });

  it('CD-54: a company template with an unknown variable is refused, and names what is allowed', () => {
    const definition = templateOf('sla.breached')!;
    const problems = templateProblems(
      definition,
      'เกินกำหนด',
      'คำขอ {{request_number}} เกินแล้ว',
    );
    expect(problems).toEqual([
      'ไม่รู้จักตัวแปร {{request_number}} — ใช้ได้เฉพาะ {{request_no}}',
    ]);
    expect(templateProblems(definition, ' ', 'x')).toContain(
      'หัวข้อต้องไม่ว่าง',
    );
  });

  it('CD-54: emails are signed with the company letterhead, only the lines that are set', () => {
    expect(
      emailSignature('OSD', {
        letterheadNameTh: 'บริษัท โอเอสดี จำกัด',
        letterheadAddress: 'กรุงเทพฯ',
        letterheadPhone: '02-000-0000',
        letterheadEmail: null,
        letterheadWebsite: 'osd.co.th',
      }),
    ).toBe('—\nบริษัท โอเอสดี จำกัด\nกรุงเทพฯ\nโทร 02-000-0000 · osd.co.th');
    expect(emailSignature('OSD', null)).toBe('—\nOSD');
  });
});

describe('CD-54 NotificationsService renders the company’s own wording', () => {
  function harness(own: { title: string; body: string } | null) {
    const created: Record<string, unknown>[] = [];
    const sent: { body: string }[] = [];
    const prisma = {
      notificationTemplate: { findUnique: jest.fn(() => Promise.resolve(own)) },
      notificationPreference: {
        findUnique: jest.fn(() => Promise.resolve(null)),
      },
      notification: {
        create: jest.fn((args: { data: Record<string, unknown> }) => {
          created.push(args.data);
          return Promise.resolve({ id: 'n-1' });
        }),
      },
      notificationDeliveryLog: { create: jest.fn(() => Promise.resolve({})) },
      user: {
        findUnique: jest.fn(() => Promise.resolve({ email: 'a@example.com' })),
      },
      company: {
        findUnique: jest.fn(() =>
          Promise.resolve({
            name: 'OSD',
            crmConfig: { letterheadNameTh: 'บริษัท โอเอสดี จำกัด' },
          }),
        ),
      },
    };
    const email = {
      isConfigured: false,
      send: jest.fn((message: { body: string }) => {
        sent.push(message);
        return Promise.resolve();
      }),
    };
    return {
      service: new NotificationsService(prisma as never, email as never),
      created,
      sent,
    };
  }

  it('without a company template the standard wording is sent', async () => {
    const { service, created } = harness(null);
    await service.slaBreached('u', 'osd', 'req-1', 'REQ-1');
    expect(created[0]).toMatchObject({
      title: 'คำขอเกินกำหนด SLA',
      body: 'คำขอ REQ-1 เกินกำหนดเวลาที่ตั้งไว้แล้ว',
    });
  });

  it('CD-54: a saved company template replaces it, and the email carries the letterhead', async () => {
    const { service, created, sent } = harness({
      title: 'ด่วน: {{request_no}} เลยกำหนด',
      body: 'กรุณาดำเนินการคำขอ {{request_no}} โดยเร็ว',
    });
    await service.slaBreached('u', 'osd', 'req-1', 'REQ-1');
    expect(created[0]).toMatchObject({
      title: 'ด่วน: REQ-1 เลยกำหนด',
      body: 'กรุณาดำเนินการคำขอ REQ-1 โดยเร็ว',
    });
    expect(sent[0].body).toBe(
      'กรุณาดำเนินการคำขอ REQ-1 โดยเร็ว\n\n—\nบริษัท โอเอสดี จำกัด',
    );
  });

  it('severity reads in Thai in the response-overdue message', async () => {
    const { service, created } = harness(null);
    await service.slaResponseOverdue('u', 'osd', 'req-1', 'REQ-1', 'high');
    expect(created[0]).toMatchObject({
      body: 'คำขอ REQ-1 (ความรุนแรง สูง) เลยเวลาตอบกลับที่กำหนดแล้ว',
    });
  });
});

describe('CD-54 NotificationTemplateAdminService', () => {
  const OSD = 'company-osd';
  const admin = {
    userId: 'admin',
    activeCompanyId: OSD,
    companies: [{ id: OSD, name: 'OSD', docPrefix: 'OSD', isPrimary: true }],
    permissions: ['admin.notification.manage'],
  } as unknown as Principal;

  function harness(existing: Record<string, unknown> | null = null) {
    const audits: Record<string, unknown>[] = [];
    const prisma = {
      notificationTemplate: {
        findMany: jest.fn(() =>
          Promise.resolve(
            existing
              ? [{ ...existing, updatedAt: new Date('2026-09-28T00:00:00Z') }]
              : [],
          ),
        ),
        findUnique: jest.fn(() => Promise.resolve(existing)),
        upsert: jest.fn((args: { create: Record<string, unknown> }) =>
          Promise.resolve({
            ...args.create,
            updatedAt: new Date('2026-09-28T00:00:00Z'),
          }),
        ),
        delete: jest.fn(() => Promise.resolve({})),
      },
    };
    const tx = {
      execute: jest.fn((fn: (client: unknown) => unknown) => fn(prisma)),
    };
    const audit = {
      record: jest.fn((entry: Record<string, unknown>) => {
        audits.push(entry);
        return Promise.resolve();
      }),
    };
    return {
      service: new NotificationTemplateAdminService(
        tx as never,
        audit as never,
      ),
      prisma,
      audits,
    };
  }

  it('lists every event with its standard wording, variables and the company override', async () => {
    const { service } = harness({
      eventType: 'sla.breached',
      title: 'ด่วน',
      body: '{{request_no}}',
    });
    const list = await service.list(admin);
    expect(list).toHaveLength(NOTIFICATION_TEMPLATES.length);
    const sla = list.find((row) => row.event_type === 'sla.breached')!;
    expect(sla.custom).toMatchObject({ title: 'ด่วน' });
    expect(sla.variables.map((v) => v.name)).toEqual(['request_no']);
    expect(
      list.find((row) => row.event_type === 'approval.awaiting')!.custom,
    ).toBeNull();
  });

  it('CD-54: saving validates, upserts for the company and audits before/after', async () => {
    const { service, prisma, audits } = harness();
    await service.save(
      'sla.breached',
      { title: 'ด่วน {{request_no}}', body: 'ดู {{request_no}}' },
      admin,
    );
    expect(prisma.notificationTemplate.upsert).toHaveBeenCalledTimes(1);
    expect(audits[0]).toMatchObject({
      eventType: 'notification.template.updated',
      before: { standard: true },
      after: { title: 'ด่วน {{request_no}}' },
    });

    await expect(
      service.save('sla.breached', { title: 'x', body: '{{nope}}' }, admin),
    ).rejects.toThrow('ไม่รู้จักตัวแปร');
    await expect(
      service.save('no.such.event', { title: 'x', body: 'y' }, admin),
    ).rejects.toThrow('ไม่พบเหตุการณ์');
  });

  it('reset removes the company wording and audits it; nothing to reset is fine', async () => {
    const withRow = harness({ title: 'ด่วน', body: 'b' });
    await withRow.service.reset('sla.breached', admin);
    expect(withRow.prisma.notificationTemplate.delete).toHaveBeenCalled();
    expect(withRow.audits[0]).toMatchObject({
      eventType: 'notification.template.reset',
    });

    const without = harness(null);
    const view = await without.service.reset('sla.breached', admin);
    expect(view.custom).toBeNull();
    expect(without.prisma.notificationTemplate.delete).not.toHaveBeenCalled();
  });

  it('SCOPE-03: another company is refused', async () => {
    const { service } = harness();
    await expect(service.list(admin, 'company-other')).rejects.toThrow();
  });
});
