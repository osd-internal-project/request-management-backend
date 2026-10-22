import {
  PERMISSIONS_KEY,
  SERVICE_ACCOUNT_ONLY_KEY,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import type { ApiKeyContext } from '@request-management/core-service';
import { ExternalLeadAiController } from './lead-ai.controller';

const LEAD = {
  id: 'lead-1',
  name: 'บจก. ตัวอย่าง',
  email: 'buyer@example.com',
  phone: '0812345678',
  contactName: 'คุณสมชาย',
  contactPosition: 'จัดซื้อ',
};

function robot(permissions: string[]): Principal {
  return {
    userId: 'svc-ai',
    activeCompanyId: 'osd',
    isServiceAccount: true,
    permissions,
  } as unknown as Principal;
}

const BOUND = { companyId: 'osd' } as ApiKeyContext;

function setup() {
  const leads = {
    findOne: jest.fn(() => Promise.resolve({ ...LEAD })),
    update: jest.fn(() => Promise.resolve({})),
    updateIntakeData: jest.fn(() => Promise.resolve({})),
    convert: jest.fn(() => Promise.resolve({})),
  };
  return {
    controller: new ExternalLeadAiController(leads as never),
    leads,
  };
}

describe('crm/ai/leads — AI acting for the company', () => {
  it('without contact.read the contact fields come back null', async () => {
    const { controller } = setup();

    const lead = await controller.findOne(
      'lead-1',
      robot(['integration.crm.lead.read']),
      BOUND,
    );

    expect(lead).toMatchObject({
      id: 'lead-1',
      name: 'บจก. ตัวอย่าง',
      email: null,
      phone: null,
      contactName: null,
      contactPosition: null,
    });
  });

  it('with contact.read the email is there', async () => {
    const { controller } = setup();

    const lead = await controller.findOne(
      'lead-1',
      robot(['integration.crm.lead.read', 'integration.crm.lead.contact.read']),
      BOUND,
    );

    expect(lead).toMatchObject({ email: 'buyer@example.com' });
  });

  it('a key bound to no company is refused before any read or write', async () => {
    const { controller, leads } = setup();
    const actor = robot(['integration.crm.lead.read']);

    await expect(
      controller.findOne('lead-1', actor, undefined),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const unbound = { companyId: null } as unknown as ApiKeyContext;
    expect(() =>
      controller.convert('lead-1', {} as never, actor, unbound),
    ).toThrow('API key ที่ผูกบริษัท');
    expect(leads.findOne).not.toHaveBeenCalled();
    expect(leads.convert).not.toHaveBeenCalled();
  });

  it('each route asks for its own scope and admits service accounts only', () => {
    const gate = (method: keyof ExternalLeadAiController) =>
      Reflect.getMetadata(
        PERMISSIONS_KEY,
        Object.getOwnPropertyDescriptor(
          ExternalLeadAiController.prototype,
          method,
        )?.value as object,
      ) as string[];

    expect(gate('findOne')).toEqual(['integration.crm.lead.read']);
    expect(gate('update')).toEqual(['integration.crm.lead.update']);
    expect(gate('updateIntakeData')).toEqual(['integration.crm.lead.update']);
    expect(gate('convert')).toEqual(['integration.crm.lead.convert']);
    expect(
      Reflect.getMetadata(SERVICE_ACCOUNT_ONLY_KEY, ExternalLeadAiController),
    ).toBe(true);
  });
});
