# request-management backend

Implements the **CTD Foundation Sprint** specification — see
[`docs/ctd-foundation-spec.md`](./docs/ctd-foundation-spec.md) for the requirement index,
[`docs/api-spec.md`](./docs/api-spec.md) for the API contract,
[`docs/data-model.md`](./docs/data-model.md) for the schema, and
[`docs/open-questions.md`](./docs/open-questions.md) for what is still unanswered.
[`AGENTS.md`](./AGENTS.md) holds the rules the spec makes non-negotiable.

**Sprint S1 (identity foundation) is implemented**; S2 (approval engine) and S3 (Platform Request)
are scaffolded — their routes and permissions exist and appear in the OpenAPI, but the handlers
return `501` naming their requirement code.

**yarn workspaces** monorepo. Each service is its own package, versioned and deployed independently,
following the house pattern from `/Users/taksapongk/Documents/Project/d-service/d-service-service`.

| Package | Path | Port |
|---|---|---|
| `@request-management/user-service` | `services/user-service` | `3001` |
| `@request-management/core-service` | `services/core-service` | `3002` |
| `@request-management/external-service` | `services/external-service` | `3003` |
| `@request-management/share` | `libs/share` | — |
| `@request-management/prisma` | `libs/prisma` | — |

Each is published at `+500` on the host (`3501`/`3502`/`3503`), which is a compose
mapping and not a second listener — see `infra/labs/docker-compose.yml` on the
`deploys/labs` branch.

**`external-service` is the only one an outside system reaches.** It serves no
screens; it serves machines, which authenticate differently (an `rfk_` API key
or a service-account token, plus `X-Acting-User`). It runs core-service's domain
providers in its own process rather than duplicating them — see
[`services/core-service/src/index.ts`](./services/core-service/src/index.ts) for
what it may import and the one thing it may never. Routes are grouped by module:

| Module | Routes |
|---|---|
| `api/v1/request/*` | the request flow, acting for a person |
| `api/v1/crm/*` | customers, leads, opportunities, quotations, sale orders, CRM admin |
| `api/v1/approval/*` | APV-07 — another module opens an approval case |
| `api/v1/mcp` | the same request calls over JSON-RPC, for tool callers |

Full documentation, including the two gates every route applies, is in
[`docs/EXTERNAL_API.md`](./docs/EXTERNAL_API.md).

```
├── package.json                  # private root: workspaces + orchestration + prisma scripts
├── tsconfig.base.json            # shared compilerOptions; every package extends it
├── .env                          # one shared env file at the root
├── libs/
│   ├── prisma/schema.prisma      # one schema for every service (+ migrations/)
│   └── share/src/
│       ├── modules/prisma/       # PrismaService, PrismaModule, PrismaTransactionService, TQueryClient
│       ├── repositories/         # BaseRepository
│       └── errors/               # AppError, AppErrorExceptionFilter
└── services/
    ├── user-service/src/{configs,auth,users}/
    ├── core-service/src/{configs,health}/
    │   └── index.ts              # what external-service may import — and may not
    └── external-service/src/
        ├── auth/                 # machine credentials: API key exchange, X-Acting-User
        └── {request,crm,approval,mcp}/
```

Services consume `@request-management/share` as a workspace dependency, importing its **source**.
There is no `dist` and no build ordering — see [`AGENTS.md`](./AGENTS.md) for the three config
pieces that make that work.

## Setup

```bash
make                 # yarn install + prisma generate
cp .env.example .env # then fill in real Keycloak/DB values
```

Or with yarn directly:

```bash
yarn install         # installs all workspaces; postinstall runs `prisma generate`
```

> **yarn only.** `packageManager` is pinned to `yarn@1.22.19`; installing with npm
> corrupts the tree. See [`AGENTS.md`](./AGENTS.md).

## Make targets

`make help` lists them all. The ones that matter:

| Target | Does |
|---|---|
| `make` | `install` + `prisma generate` — what you run on a fresh clone |
| `make build` | both services |
| `make dev-user` / `make dev-core` | start that service in watch mode |
| `make migrate` / `make deploy` | Prisma `migrate dev` / `migrate deploy` |
| `make clean` | removes every `dist/` |

`libs/share` is consumed as **TypeScript source**, so there is no build-ordering step at all —
each service can be started on its own from a cold clone:

```bash
cd services/user-service && yarn start:dev
```

## Running

```bash
yarn start:user-service:dev      # from the repo root
yarn start:core-service:dev

cd services/user-service && yarn start:dev   # or straight from the service
```

Both services serve under the `api` prefix with Swagger at `/api/docs`.

## Building

```bash
yarn build                 # both services
yarn build:user-service    # just one
```

## Versioning

Each package carries its own version and bumps independently:

```bash
yarn workspace @request-management/user-service version --patch   # core untouched
yarn workspace @request-management/core-service version --minor
```

## Keycloak (shared login across projects)

`user-service` does not run its own identity provider — it talks to the **`enterprise-crm-uat`
realm** shared with `/Users/taksapongk/Documents/Project/d-service` and
`/Users/taksapongk/Documents/Project/Osd-service-d`, configured via `KEYCLOAK_BASE_URL` /
`KEYCLOAK_REALM` / `KEYCLOAK_CLIENT_ID` / `KEYCLOAK_CLIENT_SECRET` in `.env`.

Unlike `Osd-service-d`, where the frontend holds the Keycloak config, here Keycloak is a **backend**
concern: only the backend holds these values, and the frontend gets its tokens from `user-service`.

Because both projects point at the same realm, a token issued by `POST /api/auth/login` here is
accepted by any backend validating against that realm's JWKS.

> `KEYCLOAK_CLIENT_ID` is a **public** client, so `KEYCLOAK_CLIENT_SECRET` stays blank.

Login is **OIDC Authorization Code + PKCE** (AUTH-01). There is no endpoint that accepts a
password — credentials are typed into Keycloak's own page and never reach this service. The
frontend BFF drives the two legs and stores the resulting tokens in httpOnly cookies.

| Method | Path | Description |
|---|---|---|
| POST | `/api/auth/authorize` | leg 1 → `{ authorize_url, state, code_verifier }` |
| POST | `/api/auth/callback` | leg 2: code + verifier → Keycloak token set |
| POST | `/api/auth/refresh` | `{ refreshToken }` → new token set |
| POST | `/api/auth/logout` | revokes the session, returns `end_session_url` for single logout |
| GET | `/api/auth/me` | identity, companies, roles, permissions, scope |
| POST | `/api/auth/switch-company` | change the active company without re-authenticating |

The full endpoint map is in [`docs/api-spec.md`](./docs/api-spec.md).

## Database (Prisma — structure only)

`libs/prisma/schema.prisma` holds the full CTD data model — 30 tables across Identity & Org,
Request, Approval, and Support. See [`docs/data-model.md`](./docs/data-model.md).

`PrismaService` warns rather than throwing when the database is unreachable, so the service still
boots for local work without one.

All commands run from the repo root, where the shared `.env` lives:

| Script | Command | Use |
|---|---|---|
| `yarn prisma:generate` | `prisma generate` | Regenerate the client (also runs on `postinstall`) |
| `yarn prisma:migrate` | `prisma migrate dev` | **Development** — create a migration from schema changes and apply it |
| `yarn prisma:migrate:deploy` | `prisma migrate deploy` | **Deploy** — apply committed migrations only; no prompts, never generates |
| `yarn prisma:migrate:status` | `prisma migrate status` | Compare `migrations/` against the database |
| `yarn prisma:migrate:reset` | `prisma migrate reset` | Drop and recreate — **destroys data** |
| `yarn prisma:db:push` | `prisma db push` | Push schema without a migration (prototyping) |
| `yarn prisma:studio` | `prisma studio` | Browse data |

`prisma:migrate` is the one that authors migration files; `prisma:migrate:deploy` only applies what
is already committed in `libs/prisma/migrations/`, which is what CI/production should run.

Seed development data with `yarn prisma:seed`: two companies, the six seed roles from spec
§5.2 with their permissions and scope rules, the mockup org tree, and an approval matrix whose
**ceilings are placeholders** pending open question A.

### Repositories

Data access goes through repositories, never `PrismaService` directly. `BaseRepository` in
`libs/share` supplies the CRUD surface, so a repository only spells out its domain queries:

```ts
@Injectable()
export class UsersRepository extends BaseRepository<PrismaService['user']> {
  constructor(prisma: PrismaService) { super(prisma); }
  protected delegate(client: TQueryClient) { return client.user; }

  findByKeycloakId(keycloakId: string, option?: TxOption) {
    return this.findUnique({ where: { keycloakId } }, option);
  }
}
```

Every method takes an optional `TxOption`, so the same call works inside a transaction:

```ts
await this.transactions.execute(async (prisma) => {
  const user = await this.usersRepository.upsertByKeycloakId(claims, { prisma });
  await this.auditRepository.create({ data: { userId: user.id } }, { prisma });
});
```

Repositories are provided by the feature module that owns them, not by `PrismaModule`.

## Errors

`AppErrorExceptionFilter` (registered in both `main.ts`) gives every error one shape:

```json
{ "errorCode": -1003, "abbr": "UNAUTHORIZED", "msg": "Invalid user credentials", "params": {} }
```

Throw `AppError` for domain failures; Nest `HttpException`s keep their own status. Unmapped errors
return **500**, and their messages are withheld when `NODE_ENV=production`.

## Docker

```bash
docker build -t request-management/user-service -f services/user-service/Dockerfile .
docker build -t request-management/core-service -f services/core-service/Dockerfile .
docker build -t request-management/external-service -f services/external-service/Dockerfile .
```

Build from the repo root — yarn needs every workspace manifest in the context to link them, and
`libs/share` is copied in as source.

## Adding a new service

1. `mkdir -p services/<name>/src` and add a `package.json` named `@request-management/<name>`
   (copy `services/core-service/package.json` — it has the smaller dependency set), plus
   `nest-cli.json`, `tsconfig.json`, `tsconfig.build.json`, and a `Dockerfile`.
2. Add `start:<name>` / `build:<name>` scripts to the root `package.json` and include the package in
   `build:services` and `test`.
3. **Add the new manifest to every other service's `Dockerfile`.** Each one copies *all* workspace
   manifests before `yarn install` so yarn can link them; miss one and that image stops building.
4. Add it to `scripts/generate-openapi.ts` (an import plus a `generate()` call) and to
   `strategy.matrix.service` in `.github/workflows/deploy-labs.yml` on `deploys/labs`.
5. `yarn install` to link the new workspace.
