import { ErpMockRetirementService } from './erp-mock-retirement.service';

function harness(mode: 'mock' | 'sapb1', retryIntervalMs = 300000) {
  const externalCodes = {
    updateMany: jest.fn(() => Promise.resolve({ count: 2 })),
  };
  const saleOrders = {
    updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
  };
  const service = new ErpMockRetirementService(
    { mode } as never,
    externalCodes as never,
    saleOrders as never,
    { get: jest.fn(() => retryIntervalMs) } as never,
  );
  return { service, externalCodes, saleOrders };
}

describe('เปลี่ยนจาก mock เป็น SAP จริง — เก็บข้อมูลที่ mock ออกเลขให้พ้นทาง', () => {
  it('ERP_MODE=sapb1: เลข BP ของ mock ย้ายไป sap-mock, ใบเปิดกลับเป็น pending, ใบยกเลิก → skipped', async () => {
    const h = harness('sapb1');

    await h.service.onApplicationBootstrap();

    expect(h.externalCodes.updateMany).toHaveBeenCalledWith({
      where: { system: 'sap', externalCode: { startsWith: 'MOCK-' } },
      data: { system: 'sap-mock' },
    });
    const [reopen, skip] = h.saleOrders.updateMany.mock.calls.map(
      (call) =>
        (call as unknown[])[0] as {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        },
    );
    expect(reopen.where).toEqual({
      status: 'open',
      erpOrderNo: { startsWith: 'MOCK-' },
    });
    expect(reopen.data).toMatchObject({
      erpStatus: 'pending',
      erpOrderNo: null,
    });
    expect(skip.where).toEqual({
      status: 'cancelled',
      erpOrderNo: { startsWith: 'MOCK-' },
    });
    expect(skip.data).toMatchObject({ erpStatus: 'skipped', erpOrderNo: null });
  });

  it('ERP_MODE=mock: ไม่แตะอะไร', async () => {
    const h = harness('mock');
    await h.service.onApplicationBootstrap();
    expect(h.externalCodes.updateMany).not.toHaveBeenCalled();
    expect(h.saleOrders.updateMany).not.toHaveBeenCalled();
  });

  it('external-service/tests (retry = 0): ไม่แตะ — งานนี้เป็นของ core-service', async () => {
    const h = harness('sapb1', 0);
    await h.service.onApplicationBootstrap();
    expect(h.externalCodes.updateMany).not.toHaveBeenCalled();
  });
});
