# Open questions

CTD spec §15, plus what this implementation pass settled or uncovered.

## Resolved by the PO (24 Aug 2026)

| # | Question | Answer |
|---|---|---|
| 1 | LDAP's role and where the org chart comes from | LDAP authenticates **only**. Roles are set in Keycloak. The org chart and supervisors are maintained **in this system** (AUTH-01, AUTH-04, ROLE-03) |
| 2 | Which Keycloak instance | The existing one; the dev team needs client/role admin rights |
| 3 | Approval route shape | Team lead approves every request; CFO above T1; CEO above T2 (§8.1). **The numbers are still open — see A** |
| 4 | Document number format | Company prefix leading, e.g. `OSD-DSC-202608-0042` (REQ-02) |
| 5 | Email channel | Corporate SMTP (SUP-03) |
| 6 | First sensitive fields | Discount % and margin on a discount request, visible to the requester and the approval chain (SCOPE-04) |

## Still open

| # | Question | Owner | Blocks | Status |
|---|---|---|---|---|
| **A** | Real T1 and T2 ceilings per company and request type, at minimum for discount requests | Finance / CFO | S2 and S3 **go-live** — development proceeds on placeholders | 🔴 open |
| **B** | SMTP settings (host, port, sending account) and any automated-send limits | Infra | SUP-03 real-world testing | 🔴 open |
| **C** | Realm/client admin rights on Keycloak, and agreed role naming | Infra | Was "S1 day one" | 🟢 **resolved 25 Aug 2026 — see below** |
| **D** | Who owns keeping "who reports to whom" current in the system | PO + HR | SCOPE-*, approval step 1, S3 UAT | 🔴 open |
| **E** | Test accounts per role and company for UAT, including stand-in CFO/CEO | PO + IT | UAT every sprint | 🔴 open |

### C — RESOLVED (25 Aug 2026)

Realm **`enterprise-request`**, confidential client **`request-form`**, which
backs both login and the Admin REST API — there is no separate admin client.
Its service account needs these `realm-management` roles:

    view-users, query-users, query-groups, manage-users, view-realm, manage-realm

`manage-realm` is required only so `yarn keycloak:provision` can create realm
roles. **It is a real elevation**: it lets the application change realm
configuration, not just users. If that is unacceptable, drop it and create the
six realm roles by hand once per environment — the command detects them as
already present and only seeds the mappings.

Redirect URIs must be **absolute** (`http://localhost:3000/*`). A bare `/*` is
interpreted relative to the client's root URL and login fails with
`Invalid parameter: redirect_uri`.

### C — what the earlier pass established

The existing `crm-frontend` client on the `enterprise-crm-uat` realm **already
accepts** `http://localhost:3000/api/auth/callback` as a redirect URI and
supports PKCE `S256`. Verified 24 Aug 2026 by following the generated authorize
URL: Keycloak returns its own login page rather than an invalid-redirect error.

So local development is unblocked. What remains under C:

- registering the **UAT and production** callback URLs on the client
- agreeing Keycloak role naming, which the `keycloak_role_mappings` table maps
  to system roles (currently seeded empty — every user resolves to no roles
  until mappings exist)
- deciding whether `crm-frontend` stays a public client or a confidential one
  is created for this application

### D — why this one bites earliest

Without supervisors in the org chart, `resolveChain` cannot fill approval
step 1 and submit fails with `ORG_SUPERVISOR_MISSING`. That is deliberate — the
alternative is a request that nobody is responsible for. But it means S3 UAT
cannot start until someone has populated the tree, and that is a data-entry
owner question, not an engineering one.

---

## Raised by this implementation pass

| # | Question | Why it matters | Suggested default |
|---|---|---|---|
| **F** | API base path: spec §11.1 says `/api/v1`, the services serve `/api` | Cheap now, breaking once anything integrates | Add the `v1` segment before the first external consumer |
| **G** | Attachment storage backend (REQ-03) — the spec never names one | `RequestAttachment.storageKey` assumes object storage; local disk will not survive multiple instances | S3-compatible object storage; decide before S3 |
| **H** | Should `admin` be able to read sensitive fields? | §5.2 gives admins configuration rights but no approval authority; it is silent on masking. The seed currently does **not** grant them `request.sensitive.read` | Keep it withheld — configuring a system should not imply reading its commercial data |
| **I** | Retention and archival of `AuditLog` beyond the initial 2 years (NFR-04) | The table grows without bound; no archival job exists | Partition by month, decide archival before production |
| **J** | The Keycloak group `บริษัท OSD` duplicates the `ROOT` org unit | Two places now describe the same company. Nothing reads the group — the org tree lives in the database (D-08) — so the duplication is inert, but it will confuse whoever finds it | Delete the group, or repurpose it to bundle roles. Decide before anything starts reading groups |
| **K** | The service account holds `manage-realm` | Lets the application change realm configuration, not only users — a wider blast radius than the feature strictly needs | Either accept it for `keycloak:provision`, or create realm roles manually and drop the role |
