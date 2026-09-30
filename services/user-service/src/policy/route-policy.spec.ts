import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import {
  ANY_PERMISSION_KEY,
  AUTHENTICATED_KEY,
  PERMISSIONS_KEY,
  PUBLIC_KEY,
} from '@request-management/share';

/**
 * ROLE-01: `PolicyGuard` is deny-by-default, so a route with no access policy
 * answers 403 to everyone. Reads the real decorators, not a stubbed reflector.
 */
const POLICY_KEYS = [
  PUBLIC_KEY,
  PERMISSIONS_KEY,
  ANY_PERMISSION_KEY,
  AUTHENTICATED_KEY,
];

function controllerFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return controllerFiles(path);
    return entry.name.endsWith('.controller.ts') ? [path] : [];
  });
}

function routesWithoutPolicy(): string[] {
  const reflector = new Reflector();
  const missing: string[] = [];

  for (const file of controllerFiles(join(__dirname, '..'))) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const exported: unknown = require(file);
    if (typeof exported !== 'object' || exported === null) continue;
    for (const candidate of Object.values(exported) as unknown[]) {
      if (typeof candidate !== 'function') continue;
      if (Reflect.getMetadata(PATH_METADATA, candidate) === undefined) continue;

      const prototype: unknown = candidate.prototype;
      if (typeof prototype !== 'object' || prototype === null) continue;
      for (const name of Object.getOwnPropertyNames(prototype)) {
        const handler: unknown = Reflect.get(prototype, name);
        if (typeof handler !== 'function' || name === 'constructor') continue;
        if (Reflect.getMetadata(METHOD_METADATA, handler) === undefined)
          continue;

        const declared = POLICY_KEYS.some(
          (key) =>
            reflector.getAllAndOverride<unknown>(key, [handler, candidate]) !==
            undefined,
        );
        if (!declared) missing.push(`${candidate.name}.${name}`);
      }
    }
  }

  return missing;
}

describe('ROLE-01 — every user-service route declares an access policy', () => {
  it('has no route that PolicyGuard would refuse for lack of a policy', () => {
    expect(routesWithoutPolicy()).toEqual([]);
  });
});
