import { CustomerStatus } from '@prisma/client';
import {
  CUSTOMER_TRANSITIONS,
  assertCustomerTransition,
  canTransitionCustomer,
} from './customer-state-machine';

const ALL: CustomerStatus[] = ['draft', 'active', 'suspended', 'inactive'];

describe('CM-04 customer state machine', () => {
  // DoD: "state machine มี unit test ครบตาราง transition" — every pair is
  // asserted, allowed and refused alike, so an edit to the table has to edit
  // this list and be seen doing it.
  const allowed: ReadonlyArray<[CustomerStatus, CustomerStatus]> = [
    ['draft', 'active'],
    ['draft', 'inactive'],
    ['active', 'suspended'],
    ['active', 'inactive'],
    ['suspended', 'active'],
    ['suspended', 'inactive'],
    ['inactive', 'active'],
  ];

  it.each(allowed)('allows %s → %s', (from, to) => {
    expect(canTransitionCustomer(from, to)).toBe(true);
    expect(() => assertCustomerTransition(from, to)).not.toThrow();
  });

  it('refuses every pair outside the table with CRM_CUSTOMER_STATE_INVALID', () => {
    const allowedSet = new Set(allowed.map(([f, t]) => `${f}>${t}`));

    for (const from of ALL) {
      for (const to of ALL) {
        if (from === to || allowedSet.has(`${from}>${to}`)) continue;

        expect(canTransitionCustomer(from, to)).toBe(false);
        expect(() => assertCustomerTransition(from, to)).toThrow(
          expect.objectContaining({ code: 'CRM_CUSTOMER_STATE_INVALID' }),
        );
      }
    }
  });

  it('keeps the table total — a new CustomerStatus value must be routed here', () => {
    expect(Object.keys(CUSTOMER_TRANSITIONS).sort()).toEqual([...ALL].sort());
  });

  it('never reaches draft again — a customer that existed cannot become a draft', () => {
    for (const from of ALL) {
      expect(canTransitionCustomer(from, 'draft')).toBe(false);
    }
  });
});
