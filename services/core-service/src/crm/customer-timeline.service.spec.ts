import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  accessSubject,
  salesAccessSubject,
  visibleRequestsWhere,
  visibleSalesWhere,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import { CustomerTimelineService } from './customer-timeline.service';
import { TimelineQueryDto } from './dto/customer.dto';

interface Event {
  id: string;
  customerId: string;
  refType: string;
  refId: string | null;
  eventType: string;
  requiredPermission: string | null;
  occurredAt: Date;
}

type Branch = {
  refType: string | { notIn: string[] };
  refId?: { in: string[] };
};
type Where = {
  customerId: string;
  eventType?: string;
  occurredAt?: { gte?: Date; lte?: Date };
  AND: [
    { OR: { requiredPermission: null | { in: string[] } }[] },
    { OR: Branch[] },
  ];
};

const at = (day: number) => new Date(Date.UTC(2026, 8, day));

const EVENTS: Event[] = [
  ['e-cust', 'customer', 'cust-1', 'customer.created', null, 1],
  ['e-opp-mine', 'opportunity', 'opp-mine', 'opportunity.created', null, 2],
  ['e-opp-other', 'opportunity', 'opp-other', 'opportunity.created', null, 3],
  ['e-qt-mine', 'quotation', 'qt-mine', 'quotation.accepted', null, 4],
  ['e-so-other', 'sale_order', 'so-other', 'sale_order.opened', null, 5],
  ['e-req-mine', 'request', 'req-mine', 'customer.kyc_verified', null, 6],
  [
    'e-fin',
    'customer',
    'cust-1',
    'customer.credit',
    'crm.customer.financial.read',
    7,
  ],
].map(([id, refType, refId, eventType, requiredPermission, day]) => ({
  id: id as string,
  customerId: 'cust-1',
  refType: refType as string,
  refId: refId as string,
  eventType: eventType as string,
  requiredPermission: requiredPermission as string | null,
  occurredAt: at(day as number),
}));

/** Rows each source module lets this viewer see — what its scope filter answers. */
const IN_SCOPE = new Set(['opp-mine', 'qt-mine', 'req-mine']);

function matches(event: Event, where: Where): boolean {
  if (event.customerId !== where.customerId) return false;
  if (where.eventType && event.eventType !== where.eventType) return false;
  const { gte, lte } = where.occurredAt ?? {};
  if (gte && event.occurredAt < gte) return false;
  if (lte && event.occurredAt > lte) return false;

  const permitted = where.AND[0].OR.some((clause) =>
    clause.requiredPermission === null
      ? event.requiredPermission === null
      : clause.requiredPermission.in.includes(event.requiredPermission ?? ''),
  );
  const sourced = where.AND[1].OR.some((branch) =>
    typeof branch.refType === 'string'
      ? branch.refType === event.refType &&
        (branch.refId?.in.includes(event.refId ?? '') ?? false)
      : !branch.refType.notIn.includes(event.refType),
  );
  return permitted && sourced;
}

function harness() {
  const scopeWheres: Record<string, unknown> = {};
  const source = (model: string) => ({
    findMany: jest.fn(
      (args: { where: { id: { in: string[] }; AND: unknown[] } }) => {
        scopeWheres[model] = args.where.AND[0];
        return Promise.resolve(
          args.where.id.in
            .filter((id) => IN_SCOPE.has(id))
            .map((id) => ({ id })),
        );
      },
    ),
  });

  const prisma = {
    customerTimelineEvent: {
      create: jest.fn(),
      findMany: jest.fn(
        (args: {
          where: Where & { refType?: { in: string[] } };
          distinct?: string[];
        }) => {
          if (args.distinct) {
            const kinds = args.where.refType?.in ?? [];
            return Promise.resolve(
              EVENTS.filter((e) => kinds.includes(e.refType)).map((e) => ({
                refType: e.refType,
                refId: e.refId,
              })),
            );
          }
          return Promise.resolve(EVENTS.filter((e) => matches(e, args.where)));
        },
      ),
    },
    opportunity: source('opportunity'),
    quotation: source('quotation'),
    saleOrder: source('saleOrder'),
    request: source('request'),
  };

  return {
    service: new CustomerTimelineService(prisma as never),
    prisma,
    scopeWheres,
  };
}

function viewer(permissions: string[]): Principal {
  return {
    userId: 'user-me',
    activeCompanyId: 'company-osd',
    orgUnitId: 'unit-sales',
    ledUnitIds: [],
    scopedUnitIds: [],
    scopedByPermission: {},
    permissions,
    isServiceAccount: false,
  } as unknown as Principal;
}

const ids = (rows: { id: string }[]) => rows.map((row) => row.id);

describe('C360-03 the customer timeline shows only what the viewer may see', () => {
  it('customer.read only → customer events only; no source module is queried', async () => {
    const h = harness();

    const rows = await h.service.list('cust-1', viewer(['crm.customer.read']));

    expect(ids(rows)).toEqual(['e-cust']);
    expect(h.prisma.opportunity.findMany).not.toHaveBeenCalled();
    expect(h.prisma.request.findMany).not.toHaveBeenCalled();
  });

  it('crm.sales.read → sales events only for rows inside the viewer’s sales scope', async () => {
    const h = harness();
    const me = viewer(['crm.customer.read', 'crm.sales.read']);

    const rows = await h.service.list('cust-1', me);

    // opp-other and so-other exist but sit outside this viewer's book
    expect(ids(rows).sort()).toEqual(['e-cust', 'e-opp-mine', 'e-qt-mine']);
    const salesScope = visibleSalesWhere(salesAccessSubject(me));
    expect(h.scopeWheres.opportunity).toEqual(salesScope);
    expect(h.scopeWheres.quotation).toEqual(salesScope);
    expect(h.scopeWheres.saleOrder).toEqual(salesScope);
    // no request.read → the KYC request event stays hidden
    expect(ids(rows)).not.toContain('e-req-mine');
  });

  it('request.read → the KYC request event, through the request scope filter', async () => {
    const h = harness();
    const me = viewer(['crm.customer.read', 'request.read']);

    const rows = await h.service.list('cust-1', me);

    expect(ids(rows).sort()).toEqual(['e-cust', 'e-req-mine']);
    expect(h.scopeWheres.request).toEqual(
      visibleRequestsWhere(accessSubject(me)),
    );
  });

  it('an event with requiredPermission needs that permission as well', async () => {
    const h = harness();

    const without = await h.service.list(
      'cust-1',
      viewer(['crm.customer.read']),
    );
    const withIt = await h.service.list(
      'cust-1',
      viewer(['crm.customer.read', 'crm.customer.financial.read']),
    );

    expect(ids(without)).not.toContain('e-fin');
    expect(ids(withIt)).toContain('e-fin');
  });

  it('filters by time range and event type', async () => {
    const h = harness();
    const all = viewer(['crm.customer.read', 'crm.sales.read', 'request.read']);

    const ranged = await h.service.list('cust-1', all, {
      from: at(2),
      to: at(4),
    });
    const typed = await h.service.list('cust-1', all, {
      eventType: 'opportunity.created',
    });

    expect(ids(ranged).sort()).toEqual(['e-opp-mine', 'e-qt-mine']);
    expect(ids(typed)).toEqual(['e-opp-mine']);
  });

  it('is append-only: the service exposes no way to change or remove an event', () => {
    const methods = Object.getOwnPropertyNames(
      CustomerTimelineService.prototype,
    ).filter((name) => name !== 'constructor');

    expect(methods.sort()).toEqual(['list', 'publish', 'visibleSources']);
  });

  it('a malformed from/to is rejected by validation, not turned into Invalid Date', () => {
    const bad = plainToInstance(TimelineQueryDto, { from: 'yesterday' });
    const good = plainToInstance(TimelineQueryDto, {
      from: '2026-09-01',
      to: '2026-09-24T23:59:59Z',
    });

    expect(validateSync(bad).map((e) => e.property)).toEqual(['from']);
    expect(validateSync(good)).toEqual([]);
  });
});
