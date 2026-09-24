import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  PERMISSIONS_KEY,
  PolicyGuard,
  SENSITIVE_RESOURCE_KEY,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import { CustomersController } from './customers.controller';

type Handler = keyof CustomersController;

/** The route's handler function — what the decorators attached metadata to. */
function handlerOf(name: string): object {
  return Object.getOwnPropertyDescriptor(CustomersController.prototype, name)
    ?.value as object;
}

/** Every route on the controller — a route added later is covered without editing this file. */
const HANDLERS = Object.getOwnPropertyNames(CustomersController.prototype)
  .filter((name) => name !== 'constructor')
  .filter((name) =>
    Reflect.hasMetadata('method', handlerOf(name)),
  ) as Handler[];

function declared(name: Handler): string[] {
  return (Reflect.getMetadata(PERMISSIONS_KEY, handlerOf(name)) ??
    []) as string[];
}

function guard(name: Handler, permissions: string[]): () => boolean {
  const principal = {
    userId: 'user-1',
    activeCompanyId: 'company-osd',
    permissions,
    isServiceAccount: false,
  } as unknown as Principal;
  const context = {
    getHandler: () => handlerOf(name),
    getClass: () => CustomersController,
    switchToHttp: () => ({ getRequest: () => ({ principal }) }),
  } as unknown as ExecutionContext;

  return () => new PolicyGuard(new Reflector()).canActivate(context);
}

const ALL_CRM = [
  'crm.customer.read',
  'crm.customer.manage',
  'crm.customer.sensitive.read',
  'admin.crm.manage',
];

/**
 * CM-08 / SCOPE-03 — "ไม่มีสิทธิ์ = 403" on every customer route, through the
 * real guard and the real decorators. The wrong-company half (404) is in
 * `customers.service.spec.ts`, where the scope filter lives.
 */
describe('CM-08 every customer route answers 403 without its permission', () => {
  it('found the routes', () => {
    expect(HANDLERS.length).toBeGreaterThanOrEqual(24);
  });

  it.each(HANDLERS)('%s', (name) => {
    const needed = declared(name);
    expect(needed.length).toBeGreaterThan(0);

    // Everything except what the route asks for → refused.
    const without = ALL_CRM.filter((p) => !needed.includes(p));
    expect(guard(name, without)).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
    expect(guard(name, needed)()).toBe(true);
  });
});

/**
 * CM-08 — every route that answers with a customer row has to be masked, or
 * the tax ID leaks through whichever one was forgotten. Writes return
 * `findOne(...)` too, which is how create/update/lifecycle/segments leaked
 * while list and detail were covered.
 */
describe('CM-08 routes returning a customer row are masked', () => {
  const rowRoutes: Handler[] = [
    'list',
    'findOne',
    'create',
    'update',
    'activate',
    'suspend',
    'deactivate',
    'setSegments',
  ];

  it.each(rowRoutes)('%s declares @SensitiveResource("customer")', (name) => {
    expect(Reflect.getMetadata(SENSITIVE_RESOURCE_KEY, handlerOf(name))).toBe(
      'customer',
    );
  });
});
