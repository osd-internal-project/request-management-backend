import { PERMISSIONS_KEY } from '@request-management/share';
import { ExternalAgentRecordsController } from './agent-records.controller';

/** The decorated method itself — where `SetMetadata` writes on a route. */
function handler(proto: object, name: string): object {
  const value: unknown = Object.getOwnPropertyDescriptor(proto, name)?.value;
  return typeof value === 'function' ? value : {};
}

describe('external agent-records', () => {
  it('a key without integration.agent.record.update cannot close a job', () => {
    expect(
      Reflect.getMetadata(
        PERMISSIONS_KEY,
        handler(ExternalAgentRecordsController.prototype, 'complete'),
      ),
    ).toEqual(['integration.agent.record.update']);
  });

  it("closes against the key's company, falling back to the active one", async () => {
    const records = { complete: jest.fn().mockResolvedValue({ id: 'rec-1' }) };
    const controller = new ExternalAgentRecordsController(records as never);
    const principal = { activeCompanyId: 'from-header' } as never;
    const dto = { status: 'done' as const };

    await controller.complete('rec-1', dto, principal, {
      companyId: 'osd',
    } as never);
    await controller.complete('rec-1', dto, principal, undefined);

    expect(
      (records.complete.mock.calls as unknown[][]).map((call) => call[3]),
    ).toEqual(['osd', 'from-header']);
  });
});
