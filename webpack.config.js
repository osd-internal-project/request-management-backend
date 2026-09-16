const path = require('node:path');

/**
 * Shared Nest build tweak for every service in `services/*`.
 *
 * Referenced from each service's `nest-cli.json` via `webpackConfigPath`.
 *
 * ---------------------------------------------------------------------------
 * 1. Prisma must stay OUT of the bundle
 * ---------------------------------------------------------------------------
 * The services build with `"webpack": true`, which bundles dependencies into a
 * single `dist/main.js`. That breaks Prisma: its generated client loads a
 * native query engine (`libquery_engine-<platform>.node`) by resolving paths
 * relative to its own location in `node_modules/.prisma/client`. Once inlined
 * those paths no longer exist, and the service starts cleanly but fails every
 * query with:
 *
 *   Prisma Client could not locate the Query Engine for runtime "darwin-arm64"
 *
 * Marking it external leaves `require('@prisma/client')` in the output, so Node
 * resolves it from `node_modules` at runtime — engine included.
 *
 * ---------------------------------------------------------------------------
 * 2. `libs/share` resolves from SOURCE
 * ---------------------------------------------------------------------------
 * The shared library is consumed as TypeScript source rather than a built
 * `dist`, so there is no build-ordering step: `yarn start:dev` works in any
 * service from a cold tree, and edits to `libs/share` hot-reload.
 *
 * The alias below makes that independent of the workspace symlink surviving an
 * install. Nest's default ts rule carries `exclude: /node_modules/`, which does
 * not get in the way — webpack resolves to the real path `libs/share/src/…`,
 * outside `node_modules`, so ts-loader compiles it like any other source file.
 *
 * ---------------------------------------------------------------------------
 * 3. `core-service` resolves from SOURCE too, for external-service
 * ---------------------------------------------------------------------------
 * external-service serves the outward-facing API against the same domain
 * rules, so it imports core-service's providers the same way — as source, via
 * `@request-management/core-service`. See `services/core-service/src/index.ts`
 * for what that package deliberately does *not* export, and why.
 *
 * Harmless for the other two services: an alias for a package they never
 * import costs nothing.
 */
const REPO_ROOT = __dirname;
const SHARE_SRC = path.resolve(REPO_ROOT, 'libs/share/src');
const CORE_SRC = path.resolve(REPO_ROOT, 'services/core-service/src');

const PRISMA_MODULES = /^(@prisma\/client|\.prisma\/client)(\/|$)/;

module.exports = (config) => {
  const existingExternals = Array.isArray(config.externals)
    ? config.externals
    : config.externals
      ? [config.externals]
      : [];

  return {
    ...config,
    externals: [
      ...existingExternals,
      ({ request }, callback) => {
        if (request && PRISMA_MODULES.test(request)) {
          return callback(null, `commonjs ${request}`);
        }
        return callback();
      },
    ],
    resolve: {
      ...config.resolve,
      alias: {
        ...config.resolve?.alias,
        '@request-management/share': SHARE_SRC,
        '@request-management/core-service': CORE_SRC,
      },
    },
  };
};
