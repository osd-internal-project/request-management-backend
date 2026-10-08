import type { Principal } from '@request-management/share';
import { SLA_STATUS_SQL } from '../sla/sla-status';
import { COMPUTED_TABLES, MART_TABLES } from './data-mart.repository';
import { DataMartService } from './data-mart.service';

const admin = {
  userId: 'admin-1',
  activeCompanyId: 'osd',
} as unknown as Principal;

function harness(options: { locked?: boolean; interval?: number } = {}) {
  const audits: { eventType: string }[] = [];
  const mart = {
    rebuild: jest.fn(() =>
      Promise.resolve(
        options.locked
          ? false
          : [
              { table: 'fact_sales', rows: 12, ms: 5 },
              { table: 'open_requests', rows: 3, ms: 2 },
            ],
      ),
    ),
    status: jest.fn(() => Promise.resolve([])),
  };
  const accounts = [{ customer_id: 'cus-1', health: 'red' }];
  const keeper = { martAccounts: jest.fn(() => Promise.resolve(accounts)) };
  const service = new DataMartService(
    mart as never,
    keeper as never,
    { get: jest.fn(() => options.interval ?? 0) } as never,
    {
      record: jest.fn((event: { eventType: string }) => {
        audits.push(event);
        return Promise.resolve();
      }),
    } as never,
  );
  return { service, mart, audits, keeper, accounts };
}

describe('CD-91 Data Mart', () => {
  afterEach(() => jest.useRealTimers());

  it('CD-91: the rebuild covers sales, pipeline, target vs actual, open requests and the daily backlog', () => {
    expect(MART_TABLES.map((step) => step.table)).toEqual([
      'fact_sales',
      'fact_pipeline',
      'fact_leads',
      'fact_deals',
      'sales_target_actual',
      'open_requests',
      'request_backlog_daily',
      'fact_projects',
      'project_health_weekly',
      'fact_utilization',
      'fact_delivery_phases',
      'fact_receivables',
      // CD-274
      'fact_campaigns',
      'fact_campaign_monthly',
      'fact_kb_ai_monthly',
      'fact_kb_gaps_monthly',
      // CD-295
      'fact_smart_prospects',
      'fact_smart_calls',
    ]);
    // CD-92 — then the tables the application computes, trend after source
    expect([...COMPUTED_TABLES]).toEqual([
      'customer_accounts',
      'customer_health_daily',
    ]);
    // the backlog snapshot is built from the open requests just rebuilt
    const order = MART_TABLES.map((step) => step.table);
    expect(order.indexOf('open_requests')).toBeLessThan(
      order.indexOf('request_backlog_daily'),
    );
  });

  it('CD-50: overdue in the mart is the one definition (SLA_STATUS_SQL)', () => {
    const open = MART_TABLES.find((step) => step.table === 'open_requests');
    expect(open?.sql.join('\n')).toContain(SLA_STATUS_SQL);
  });

  it('months are Bangkok months of UTC-stored timestamps, never the naive zone shift', () => {
    const all = MART_TABLES.flatMap((step) => step.sql).join('\n');
    expect(all).toContain(`AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Bangkok'`);
    // `col AT TIME ZONE 'Asia/Bangkok'` on a timestamp column shifts the wrong way
    expect(all).not.toMatch(/"\s*AT TIME ZONE 'Asia\/Bangkok'/);
  });

  it('SCOPE-04: no form contents reach the mart', () => {
    const all = MART_TABLES.flatMap((step) => step.sql).join('\n');
    expect(all).not.toMatch(/formData|receiverFormData|stepFormData|payload/);
  });

  it('only today’s backlog rows are replaced — earlier days stay as they were', () => {
    const backlog = MART_TABLES.find(
      (step) => step.table === 'request_backlog_daily',
    );
    expect(backlog?.sql[0]).toMatch(
      /DELETE FROM mart\.request_backlog_daily WHERE snapshot_date =/,
    );
  });

  it('CD-92: the Keeper health written to the mart is KeeperService’s own, computed before the rebuild', async () => {
    const h = harness();
    await h.service.refresh();
    expect(h.keeper.martAccounts).toHaveBeenCalledTimes(1);
    expect(h.mart.rebuild).toHaveBeenCalledWith(h.accounts);
  });

  it('CD-92: a contact attempt in the mart is CD-85’s definition, not a second list', () => {
    const leads = MART_TABLES.find((step) => step.table === 'fact_leads');
    expect(leads?.sql.join('\n')).toContain(
      "a.type IN ('call','email','meeting','visit','line','social')",
    );
  });

  it('a manual rebuild is audited and answers the fresh status', async () => {
    const h = harness();
    await h.service.refreshNow(admin);
    expect(h.mart.rebuild).toHaveBeenCalledTimes(1);
    expect(h.audits.map((a) => a.eventType)).toEqual(['bi.mart.refreshed']);
    expect(h.mart.status).toHaveBeenCalled();
  });

  it('while another instance rebuilds, a manual rebuild says so and records nothing', async () => {
    const h = harness({ locked: true });
    await expect(h.service.refreshNow(admin)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(h.audits).toHaveLength(0);
  });

  it('interval 0 (tests, external-service) starts no timer', () => {
    jest.useFakeTimers();
    const h = harness({ interval: 0 });
    h.service.onModuleInit();
    jest.advanceTimersByTime(10 * 3_600_000);
    expect(h.mart.rebuild).not.toHaveBeenCalled();
  });

  it('with a timer: a first rebuild soon after boot, then every interval', async () => {
    jest.useFakeTimers();
    const h = harness({ interval: 3_600_000 });
    h.service.onModuleInit();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(h.mart.rebuild).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(3_600_000);
    expect(h.mart.rebuild).toHaveBeenCalledTimes(2);
    h.service.onModuleDestroy();
  });
});
