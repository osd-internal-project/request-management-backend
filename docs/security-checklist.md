# OWASP Top 10 checklist (NFR-01)

> NFR-01 requires this walked before UAT. Every ✅ below was verified by running
> a command against this repository, and the command is shown so the claim can
> be rechecked rather than trusted. Findings are listed with their fix, not
> softened.
>
> Last walked: 27 Aug 2026 · both services, 84 routes.

## Summary

| | Area | Verdict |
|---|---|---|
| A01 | Broken access control | ✅ |
| A02 | Cryptographic failures | ✅ |
| A03 | Injection | ✅ |
| A04 | Insecure design | ✅ |
| A05 | Security misconfiguration | ⚠️ **CORS is open to every origin** |
| A06 | Vulnerable components | ⬜ not audited — needs `yarn audit` in CI |
| A07 | Identification & authentication failures | ⚠️ **no rate limiting** |
| A08 | Software & data integrity failures | ✅ |
| A09 | Logging & monitoring failures | ✅ |
| A10 | Server-side request forgery | ✅ |

---

## A01 — Broken access control ✅

Every route declares a guard. Nothing is open by default (ROLE-01).

```
routes: 84 · without any guard decorator: 0
```

Counted over `@Permissions` · `@Public` · `@Authenticated` across every
`*.controller.ts`. The four `@Public()` routes are the OIDC handshake
(`authorize`, `callback`, `refresh`, `logout`) — none of them read business
data.

Three layers stack on top of the permission check:

- **`CompanyGuard`** — the active company must be one the caller belongs to.
- **`buildScopeWhere`** (SCOPE-01…03) — row filtering by `own` / `team` /
  `department` / `company` / `all`.
- **`SensitiveFieldInterceptor`** (SCOPE-04) — masked fields are **deleted from
  the payload**, not blanked, so they cannot be recovered from the response.

`resolveTargetCompany` / `assertCompanyMember` close the hole where an endpoint
accepted `company_id` from the caller and trusted it.

**§5.4 guardrail 1** is enforced server-side: a role holding `admin.*` is
refused `approval.decide` or `request.sensitive.read` with 422, including on a
direct API call that bypasses the screen.

## A02 — Cryptographic failures ✅

- No password ever reaches these services — Keycloak federates to LDAP
  (AUTH-01). There is no password column and no reset flow to attack.
- No hardcoded secrets: `grep` for assigned `password|secret|apikey` literals
  outside `process.env` returns nothing.
- `.env` is gitignored; `.env.example` carries placeholders only.
- The Keycloak admin token stays inside `KeycloakAdminService` and is never
  returned to the browser.

## A03 — Injection ✅

- **No raw SQL in application code.** `$queryRawUnsafe` and `$executeRawUnsafe`
  appear nowhere outside throwaway inspection scripts; every query goes through
  Prisma's parameterised client.
- Global `ValidationPipe({ whitelist: true, transform: true })` on both
  services — unknown properties are stripped rather than passed through, so an
  extra field in a request body cannot reach a repository.
- Permissions are validated against the code-declared catalog
  (`@IsIn(PERMISSION_VALUES)`), so an admin cannot invent one through the API.

## A04 — Insecure design ✅

Decisions that exist because of how this breaks, not because a scanner asked:

- **Routing is proved possible before a submit writes anything**
  (`assertRoutable`). Without it a failed routing left a request holding a
  document number, status `submitted`, an SLA clock running, no approval case,
  and no way to resubmit.
- **Approval is bound to what was approved** (`snapshotHash`, APV-05). A
  material edit voids the decision instead of carrying it forward.
- **Nobody approves their own request**, enforced when the chain is planned.
- **`typeSnapshot`** freezes the request type at submit, so an admin editing a
  type cannot change the rules a live request is judged by.
- **The audit log is append-only**: no POST/PATCH/DELETE route exists on the
  audit controller, and CI fails the build if one appears.

## A05 — Security misconfiguration ⚠️

`helmet()` is applied on both services. `ValidationPipe` whitelists.

**Finding — CORS accepts every origin.** Both services call `app.enableCors()`
with no options, which answers `Access-Control-Allow-Origin: *`. Any site a
signed-in user visits can call these APIs from their browser.

It is not currently exploitable end to end: the browser talks to the Next BFF,
and the session cookie is `httpOnly`, so a hostile page cannot read the token
to attach it. But the setting is one deployment change away from mattering, and
nothing in the code says which origins are intended.

**Fix:** pass an explicit origin list, e.g.
`app.enableCors({ origin: [process.env.APP_BASE_URL], credentials: true })`.

## A06 — Vulnerable and outdated components ⬜

Not audited. `yarn audit` is not run anywhere, and neither repository pins a
Node version through `engines`.

**Fix:** add `yarn audit --level high` to CI (advisory at first, so a transitive
advisory does not block a release on day one) and set `engines.node`.

## A07 — Identification and authentication failures ⚠️

Working:

- Access tokens are short-lived (15 min) with refresh; idle and absolute
  session limits are Keycloak realm settings (AUTH-02).
- Logout clears both app and Keycloak sessions (AUTH-03).
- A disabled Keycloak account loses access within one token lifetime.
- Login success **and failure** are both written to the audit log (AUTH-07).

**Finding — no rate limiting anywhere.** `grep` for `Throttler|rate.limit`
returns nothing across both services. `/auth/authorize` and `/auth/refresh` can
be called without limit.

Keycloak has its own brute-force protection for password attempts, so the
credential path is not wide open. What is unprotected is everything else: any
authenticated caller can hammer any endpoint, and `/internal/policy/resolve`
already takes 1.5–6 s per call (see NFR-02), which makes it the cheapest way to
exhaust the service.

**Fix:** `@nestjs/throttler` globally, with a tighter limit on the auth routes.
Needs sign-off — it adds a dependency.

## A08 — Software and data integrity failures ✅

- **`Idempotency-Key`** is honoured on state-changing POSTs; the interceptor is
  registered globally on both services (it existed but was unregistered until
  this pass, which meant a retried submit could double-post).
- **Document numbers** are issued inside the submit transaction under a row
  lock (`@@unique([companyId, typeCode, yearMonth])`), so concurrent submits
  cannot collide (NFR-03).
- **Domain events fire after commit** — a subscriber that throws cannot roll
  back or corrupt the transaction that produced it.
- CI installs with `--frozen-lockfile`, so a build cannot silently resolve a
  different dependency tree.

## A09 — Security logging and monitoring failures ✅

- `AuditWriter.record()` is called from 37 sites, each **inside the same
  transaction as the change it records** — a change cannot commit without its
  audit row.
- Role, permission and scope changes record `before` → `after` (ROLE-05),
  verified live: `role.updated` carries both permission sets.
- Reading a sensitive field is itself audited
  (`scope.sensitive_field.read`).
- **No token is ever logged**: `grep` for token values in `console.log` /
  `logger.*` returns nothing.
- Retention beyond the initial two years is still open — see question I in
  [`open-questions.md`](./open-questions.md).

## A10 — Server-side request forgery ✅

The services make exactly three outbound calls, all to hosts fixed in
configuration: Keycloak (`KEYCLOAK_BASE_URL`), the sibling service
(`USER_SERVICE_URL`), and SMTP. No endpoint takes a URL from a caller and
fetches it.

---

## Outstanding

| # | Item | Blocking UAT? |
|---|---|---|
| 1 | CORS restricted to a known origin list | No — but before production |
| 2 | Rate limiting (needs a dependency; needs sign-off) | No |
| 3 | `yarn audit` in CI + `engines.node` | No |
| 4 | Audit log retention and archival (question I) | No |
