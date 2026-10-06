import { currentStage, FlowFacts, nextSteps } from './flow-stage';

const none: FlowFacts = {
  dealStage: 'qualifying',
  solutionRequests: 0,
  solutions: 0,
  quotations: 0,
  saleOrders: 0,
  contractRequests: 0,
  contracts: 0,
  projects: 0,
};

describe('currentStage — how far a deal has travelled', () => {
  it('a bare deal is at the opportunity', () => {
    expect(currentStage(none)).toBe('opportunity');
  });

  it('a solution request alone puts it in Pre-Sales', () => {
    expect(currentStage({ ...none, solutionRequests: 1 })).toBe('presales');
  });

  it('is the furthest stage reached, not the last touched', () => {
    // A small deal skips Pre-Sales; a contract outranks the quotation.
    expect(currentStage({ ...none, quotations: 2, contracts: 1 })).toBe(
      'contract',
    );
    expect(currentStage({ ...none, solutions: 1, projects: 1 })).toBe(
      'project',
    );
  });

  it('a contract request counts before the contract is recorded', () => {
    expect(currentStage({ ...none, saleOrders: 1, contractRequests: 1 })).toBe(
      'contract',
    );
  });

  it('a lost deal that never sold reads lost', () => {
    expect(currentStage({ ...none, dealStage: 'lost', quotations: 1 })).toBe(
      'lost',
    );
  });

  it('a sale order outranks a later loss', () => {
    expect(currentStage({ ...none, dealStage: 'lost', saleOrders: 1 })).toBe(
      'sale_order',
    );
  });
});

describe('nextSteps — the calls that move a deal on', () => {
  const context = {
    opportunityId: 'opp-1',
    opportunityCode: 'OPP-OSD-0001',
    solutionTypeCode: 'SOL',
    contractTypeCode: 'CTR',
  };

  it('offers the solution request with the deal as its reference', () => {
    const [first] = nextSteps('opportunity', context);

    expect(first.path).toBe('/api/v1/request/requests');
    expect(first.note).toContain('type_code=SOL');
    expect(first.note).toContain('ref_id=OPP-OSD-0001');
  });

  it('offers no hand-off the company has not configured', () => {
    const steps = nextSteps('sale_order', {
      ...context,
      contractTypeCode: null,
    });

    expect(steps).toEqual([]);
  });

  it('a lost deal has nowhere to go', () => {
    expect(nextSteps('lost', context)).toEqual([]);
  });
});
