import { MAX_TAKEN_SKIPS, firstFreeCode } from './doc-code';
import { OpportunityCodeService } from './opportunity-code.service';
import { QuotationCodeService } from './quotation-code.service';
import { SaleOrderCodeService } from './sale-order-code.service';

/**
 * OPP/SO/QT numbers are unique across companies while their counters are per
 * company — a number another company already holds must be skipped, not fail
 * the insert (same rule as CM-02 customer codes).
 */
describe('document codes skip numbers taken by another company', () => {
  function txWith(taken: string[]) {
    let seq = 0;
    const lookup = ({ where }: { where: Record<string, string> }) =>
      Promise.resolve(
        taken.includes(Object.values(where)[0]) ? { id: 'x' } : null,
      );
    return {
      company: {
        findUnique: jest.fn(() => Promise.resolve({ docPrefix: 'OSD' })),
      },
      $queryRaw: jest.fn(() => Promise.resolve([{ lastSeq: ++seq }])),
      opportunity: { findUnique: jest.fn(lookup) },
      saleOrder: { findUnique: jest.fn(lookup) },
      quotation: { findFirst: jest.fn(lookup) },
    };
  }

  it.each([
    ['OPP', new OpportunityCodeService({} as never)],
    ['SO', new SaleOrderCodeService({} as never)],
    ['QT', new QuotationCodeService()],
  ])('%s skips taken numbers', async (kind, service) => {
    const tx = txWith([`${kind}-OSD-000001`, `${kind}-OSD-000002`]);
    await expect(service.issue('company-osd', tx as never)).resolves.toBe(
      `${kind}-OSD-000003`,
    );
    expect(tx.$queryRaw).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['OPP', new OpportunityCodeService({} as never)],
    ['SO', new SaleOrderCodeService({} as never)],
    ['QT', new QuotationCodeService()],
  ])('%s takes the first number when free', async (kind, service) => {
    const tx = txWith([]);
    await expect(service.issue('company-osd', tx as never)).resolves.toBe(
      `${kind}-OSD-000001`,
    );
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('gives up after MAX_TAKEN_SKIPS instead of looping forever', async () => {
    const next = jest.fn(() => Promise.resolve('X'));
    await expect(
      firstFreeCode('test counter', next, () => Promise.resolve(true)),
    ).rejects.toThrow('test counter is behind');
    expect(next).toHaveBeenCalledTimes(MAX_TAKEN_SKIPS);
  });
});
