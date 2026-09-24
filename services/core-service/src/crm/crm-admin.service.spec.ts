import { Principal } from '@request-management/share';
import { CrmAdminService } from './crm-admin.service';

function principal(): Principal {
  return {
    userId: 'admin',
    username: 'admin',
    isServiceAccount: false,
    activeCompanyId: 'osd',
    permissions: ['admin.crm.manage'],
  } as unknown as Principal;
}

const LOGO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAE=';

function harness() {
  const upserts: {
    create: Record<string, unknown>;
    update: Record<string, unknown>;
  }[] = [];
  const audits: { eventType: string; after: Record<string, unknown> }[] = [];

  const configs = {
    upsert: jest.fn(
      (args: {
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        upserts.push(args);
        return Promise.resolve({ id: 'cfg', ...args.update });
      },
    ),
  };
  const audit = {
    record: jest.fn(
      (entry: { eventType: string; after: Record<string, unknown> }) => {
        audits.push(entry);
        return Promise.resolve();
      },
    ),
  };
  const transactions = {
    execute: jest.fn((work: (prisma: unknown) => Promise<unknown>) => work({})),
  };

  const service = new CrmAdminService(
    {} as never,
    {} as never,
    {} as never,
    configs as never,
    audit as never,
    transactions as never,
    {} as never,
    { assertCodes: jest.fn(() => Promise.resolve()) } as never,
  );
  return { service, upserts, audits };
}

describe('CD-76 หัวกระดาษใบเสนอราคาในตั้งค่า CRM', () => {
  it('CD-76 an omitted field is untouched, "" clears it, text is trimmed', async () => {
    const { service, upserts } = harness();

    await service.updateConfig(
      { letterhead_name_th: '  บริษัท โอเอสดี จำกัด ', letterhead_phone: '' },
      principal(),
    );

    const { update } = upserts[0];
    expect(update.letterheadNameTh).toBe('บริษัท โอเอสดี จำกัด');
    expect(update.letterheadPhone).toBeNull();
    expect(update.letterheadAddress).toBeUndefined();
  });

  it('CD-76 SUP-04 the audit entry records that the logo changed, not the image itself', async () => {
    const { service, upserts, audits } = harness();

    await service.updateConfig({ letterhead_logo: LOGO }, principal());

    expect(upserts[0].update.letterheadLogo).toBe(LOGO);
    expect(audits[0].eventType).toBe('crm.config.updated');
    expect(audits[0].after.letterheadLogo).toBe('[logo]');
    expect(JSON.stringify(audits[0].after)).not.toContain('base64');
  });
});
