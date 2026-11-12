import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
 * H3: company isolation is pinned by hand in every query, so one that forgets
 * `companyId` crosses tenants silently. This watches every model call and
 * reports the ones on a company-owned table whose `where` never names it.
 *
 * `log` reports each offending call site once per process; `throw` refuses it
 * (tests, `make smoke`); `off` does nothing.
 */
export type TenantGuardMode = 'off' | 'log' | 'throw';

export const COMPANY_SCOPED_MODELS: ReadonlySet<string> = new Set(
  Prisma.dmmf.datamodel.models
    .filter((model) => model.fields.some((field) => field.name === 'companyId'))
    .map((model) => model.name),
);

/** Reads and bulk writes; a by-id `findUnique` is loaded and then compared. */
const GUARDED_OPERATIONS: ReadonlySet<string> = new Set([
  'findMany',
  'findFirst',
  'findFirstOrThrow',
  'count',
  'aggregate',
  'groupBy',
  'updateMany',
  'deleteMany',
]);

export function tenantGuardMode(value: string | undefined): TenantGuardMode {
  return value === 'off' || value === 'throw' ? value : 'log';
}

// shortcut: any `companyId` key anywhere in the tree counts, so an OR with one
// scoped branch passes; P3's per-module filters are the precise check.
function namesCompany(where: unknown): boolean {
  if (Array.isArray(where)) return where.some(namesCompany);
  if (where === null || typeof where !== 'object') return false;

  return Object.entries(where).some(
    ([key, value]) => key === 'companyId' || namesCompany(value),
  );
}

/** True when this call reads or bulk-writes company rows without naming one. */
export function lacksCompanyScope(
  model: string | undefined,
  operation: string,
  args: unknown,
): boolean {
  if (!model || !COMPANY_SCOPED_MODELS.has(model)) return false;
  if (!GUARDED_OPERATIONS.has(operation)) return false;

  const where =
    args !== null && typeof args === 'object' && 'where' in args
      ? (args as { where?: unknown }).where
      : undefined;
  return !namesCompany(where);
}

/** The first stack frame outside Prisma and this file: where the query was written. */
function callSite(): string {
  const frames = (new Error().stack ?? '').split('\n').slice(1);
  const own = frames.find(
    (frame) =>
      !frame.includes('node_modules') &&
      !frame.includes('tenant-guard') &&
      !frame.includes('node:internal'),
  );
  return own?.trim() ?? 'unknown';
}

export function tenantGuardExtension(mode: TenantGuardMode) {
  const logger = new Logger('TenantGuard');
  const reported = new Set<string>();

  return Prisma.defineExtension({
    name: 'tenant-guard',
    query: {
      $allModels: {
        $allOperations({ model, operation, args, query }) {
          if (mode !== 'off' && lacksCompanyScope(model, operation, args)) {
            const site = callSite();
            const message = `${model}.${operation} without companyId at ${site}`;

            if (mode === 'throw') {
              throw new Error(`TenantGuard: ${message}`);
            }
            const key = `${model}.${operation}|${site}`;
            if (!reported.has(key)) {
              reported.add(key);
              logger.warn(message);
            }
          }
          return query(args);
        },
      },
    },
  });
}
