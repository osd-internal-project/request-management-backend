import { AuditService } from './audit.service';

function service() {
  const repository = {
    search: jest.fn().mockResolvedValue([]),
    countWhere: jest.fn().mockResolvedValue(0),
  };
  return { audit: new AuditService(repository as never), repository };
}

describe('P8 — the audit log keeps to a company (SCOPE-03)', () => {
  it('a company screen reads only its active company', async () => {
    const { audit, repository } = service();

    await audit.search(
      { page: 1, page_size: 50, event_type: 'role.granted' },
      'osd',
    );

    expect(repository.search).toHaveBeenCalledWith(
      { companyId: 'osd', eventType: 'role.granted' },
      expect.anything(),
    );
  });

  it('the system screen reads every company unless it names one', async () => {
    const { audit, repository } = service();

    await audit.search({ page: 1, page_size: 50 }, undefined);

    expect(repository.search).toHaveBeenCalledWith(
      { companyId: undefined },
      expect.anything(),
    );
  });
});
