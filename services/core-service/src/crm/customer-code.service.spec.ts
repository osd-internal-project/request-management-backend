import { CustomerCodeService } from './customer-code.service';

/**
 * CM-02 — customerCode is unique across companies, the counter is per company.
 * A company whose docPrefix another company once used (OSDD was OSD) must skip
 * the codes already issued under it instead of failing the customer insert.
 */
describe('CM-02 CustomerCodeService.issue', () => {
  function txWith(taken: string[], startSeq = 0) {
    let seq = startSeq;
    return {
      company: {
        findUnique: jest.fn(() => Promise.resolve({ docPrefix: 'OSD' })),
      },
      crmCompanyConfig: { findUnique: jest.fn(() => Promise.resolve(null)) },
      $queryRaw: jest.fn(() => Promise.resolve([{ lastSeq: ++seq }])),
      customer: {
        findUnique: jest.fn(({ where }: { where: { customerCode: string } }) =>
          Promise.resolve(
            taken.includes(where.customerCode) ? { id: 'x' } : null,
          ),
        ),
      },
    };
  }

  const service = new CustomerCodeService({} as never);

  it('issues the next sequence when the code is free', async () => {
    const tx = txWith([]);
    await expect(service.issue('company-osd', tx as never)).resolves.toBe(
      'CUS-OSD-000001',
    );
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('skips codes already taken by another company', async () => {
    const tx = txWith(['CUS-OSD-000001', 'CUS-OSD-000002']);
    await expect(service.issue('company-osd', tx as never)).resolves.toBe(
      'CUS-OSD-000003',
    );
    expect(tx.$queryRaw).toHaveBeenCalledTimes(3);
  });
});
