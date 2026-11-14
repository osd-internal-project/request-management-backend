import { AppError, type Principal } from '@request-management/share';
import { WorkOrdersService } from './work-orders.service';

const actor = {
  userId: 'me',
  activeCompanyId: 'osd',
  permissions: ['notification.read'],
} as unknown as Principal;

function serviceWith(requestVisible: boolean) {
  const orders = { findFirst: jest.fn(() => Promise.resolve(null)) };
  const requests = {
    findOne: jest.fn(() =>
      requestVisible
        ? Promise.resolve({ id: 'req-1' })
        : Promise.reject(new AppError('NOT_FOUND', 'ไม่พบคำขอที่ระบุ')),
    ),
  };
  const deps: unknown[] = Array.from({ length: 13 }, () => ({}));
  deps[0] = orders;
  deps[6] = requests;
  const service = new (WorkOrdersService as unknown as new (
    ...a: unknown[]
  ) => WorkOrdersService)(...deps);
  return { service, orders, requests };
}

describe('SCOPE-02 a request page asks for its work order', () => {
  it('a request the caller cannot open answers 404, and no work order is read', async () => {
    const { service, orders } = serviceWith(false);

    await expect(service.ofRequest(actor, 'req-1')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(orders.findFirst).not.toHaveBeenCalled();
  });

  it('a request the caller can open: no work order is null', async () => {
    const { service, requests } = serviceWith(true);

    await expect(service.ofRequest(actor, 'req-1')).resolves.toBeNull();
    expect(requests.findOne).toHaveBeenCalledWith('req-1', actor);
  });

  it('a company key reading as the company is not held to one person’s requests', async () => {
    const { service, requests, orders } = serviceWith(false);
    const machine = { ...actor, isServiceAccount: true } as Principal;

    await expect(service.ofRequest(machine, 'req-1')).resolves.toBeNull();
    expect(requests.findOne).not.toHaveBeenCalled();
    expect(orders.findFirst).toHaveBeenCalled();
  });
});
