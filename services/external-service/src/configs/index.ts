import { parseCompanyDbs } from '@request-management/core-service';

export default () => ({
  env: process.env.NODE_ENV ?? 'local',
  port: Number(process.env.EXTERNAL_SERVICE_PORT ?? process.env.PORT ?? 3003),
  serviceName: 'external-service',

  /**
   * Where to resolve callers. Same as core-service: this service holds no
   * identity tables and does not verify tokens — user-service does (§03).
   */
  userServiceUrl:
    process.env.USER_SERVICE_URL ?? 'http://localhost:3001/api/v1',

  /**
   * ที่ที่ขอเลขรัน — service นี้รัน `RequestsModule` ของ core ในโปรเซสตัวเอง
   * จึงเรียก `RunNumberClient` ด้วย (docs/run-number.md).
   */
  runNumberServiceUrl:
    process.env.RUN_NUMBER_SERVICE_URL ?? 'http://localhost:3004/api/v1',

  /**
   * AUTH-06: what an API key is exchanged for.
   *
   * An `rfk_` key resolves to a Keycloak client-credentials token for this
   * client, forwarded exactly as a caller-supplied token would be, so
   * user-service remains the only verifier. The realm details are duplicated
   * from user-service's `keycloak.config.ts` rather than imported, because the
   * services are deployed separately.
   */
  keycloak: {
    baseUrl: process.env.KEYCLOAK_BASE_URL ?? 'http://192.168.31.51:8180',
    realm: process.env.KEYCLOAK_REALM ?? 'enterprise-request',
  },
  integration: {
    clientId: process.env.INTEGRATION_CLIENT_ID ?? '',
    clientSecret: process.env.INTEGRATION_CLIENT_SECRET ?? '',
  },

  /**
   * Where callers outside this machine reach *this* service.
   *
   * Needed by the MCP OAuth discovery document, which has to state its own
   * address: a client is told "this resource lives at X, authorise at Y", and
   * X must be the URL *it* used, not `localhost`. Everything else answers on
   * whatever host the request arrived at and never has to name itself.
   *
   * Docker maps 3503 → 3003, so the default is the port a caller on the
   * network actually uses.
   */
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? 'http://192.168.31.52:3503',

  /**
   * Every background timer in the imported domain, off.
   *
   * This service runs core-service's providers in its own process against the
   * same database (see `services/core-service/src/index.ts`). The domain
   * modules it needs pull in the ones that sweep on an interval —
   * `RequestsModule` imports `SlaModule`, `CrmModule` imports the ERP (SAP) and
   * workflow retry loops — and a second sweeper on the same tables is one
   * duplicate notification per late request, and one duplicate sync attempt
   * per pending job.
   *
   * Zero disables each timer; the services already read it that way for tests
   * (`sla-monitor.service.ts`). **Owning the clocks is core-service's job and
   * must stay that way** — if a timer ever has to move here, it moves, not
   * gets added.
   */
  slaSweepIntervalMs: 0,
  /** CD-91 — BiModule is not imported here today; zero keeps it so if it ever is. */
  martRefreshIntervalMs: 0,
  /** CD-271 — the content calendar's reminders run on core-service only. */
  macom: { contentSweepIntervalMs: 0 },
  /** CD-241 — SupportModule is imported since 6 Oct 2026 (`support/*`); its sweeps stay off. */
  service: {
    onCallSweepIntervalMs: 0,
    pmSweepIntervalMs: 0,
    claimSweepIntervalMs: 0,
  },
  /**
   * The post-deal modules (6 Oct 2026) import PM, Delivery, HR and e-sign's
   * domain halves, and with them their sweeps. Same rule as above: zero here,
   * the clocks are core-service's.
   */
  pm: { statusReportIntervalMs: 0, costSweepIntervalMs: 0 },
  delivery: {
    readinessIntervalMs: 0,
    retentionIntervalMs: 0,
    handoverIntervalMs: 0,
    receivableIntervalMs: 0,
  },
  hr: { mandayVarianceIntervalMs: 0 },
  esign: { sweepIntervalMs: 0 },
  // CD-262/263 sweeps and CD-265's text purge run in core-service only
  kb: {
    reviewIntervalMs: 0,
    ingestIntervalMs: 0,
    aiPurgeIntervalMs: 0,
    aiRetentionDays: Number(process.env.KB_AI_RETENTION_DAYS ?? 180),
  },
  notificationDigestIntervalMs: 0,
  /** CD-90 — likewise: the lake is fed by core-service only. */
  lake: { databaseUrl: '', extractIntervalMs: 0, sapIntervalMs: 0 },
  /** CD-78 — Reserve-phone (the phone number inventory); only `mock` exists yet. */
  reservePhone: {
    mode: process.env.RESERVE_PHONE_MODE ?? 'mock',
    /** How long a new hold lasts, and the longest one may be set or extended to. */
    holdDays: Number(process.env.RESERVE_PHONE_HOLD_DAYS ?? 14),
    maxHoldDays: Number(process.env.RESERVE_PHONE_MAX_HOLD_DAYS ?? 60),
  },
  /**
   * CD-51 — Microsoft Teams notifications (a bot's 1:1 chat per person).
   * off (default) = no Teams channel · mock = log only · botframework = real.
   */
  teams: {
    mode: process.env.TEAMS_MODE ?? 'off',
    bot: {
      tenantId: process.env.TEAMS_TENANT_ID,
      appId: process.env.TEAMS_BOT_APP_ID,
      appPassword: process.env.TEAMS_BOT_APP_PASSWORD,
      serviceUrl:
        process.env.TEAMS_SERVICE_URL ??
        'https://smba.trafficmanager.net/apac/',
    },
    /** The card's "open" button: `<PUBLIC_WEB_URL>/pages/notifications`. */
    publicWebUrl: process.env.PUBLIC_WEB_URL,
    /** How often queued messages are sent (ms); 0 = off. */
    deliveryIntervalMs: 0,
  },
  erp: {
    mode: process.env.ERP_MODE ?? 'mock',
    /**
     * ERP_MODE=sapb1 — SAP Business One Service Layer (on-premise).
     * ERP_B1_COMPANY_DBS maps `companies.code` to a CompanyDB:
     * `OSD=SBO_OSD,LEXTECH=SBO_LEX`. A self-signed Service Layer certificate
     * is trusted through ERP_B1_CA_FILE; ERP_B1_TLS_INSECURE is the last resort.
     */
    b1: {
      baseUrl: process.env.ERP_B1_BASE_URL ?? '',
      username: process.env.ERP_B1_USERNAME ?? '',
      password: process.env.ERP_B1_PASSWORD ?? '',
      companyDbs: parseCompanyDbs(process.env.ERP_B1_COMPANY_DBS),
      serviceItemCode: process.env.ERP_B1_SERVICE_ITEM || undefined,
      warehouseCode: process.env.ERP_B1_WAREHOUSE || undefined,
      vatGroup: process.env.ERP_B1_VAT_GROUP || undefined,
      caFile: process.env.ERP_B1_CA_FILE || undefined,
      tlsInsecure: process.env.ERP_B1_TLS_INSECURE === 'true',
      timeoutMs: Number(process.env.ERP_B1_TIMEOUT_MS ?? 30000),
    },
    retryIntervalMs: 0,
    refreshIntervalMs: 0,
    itemsRefreshIntervalMs: 0,
    vendorCostsRefreshIntervalMs: 0,
  },
  workflow: {
    mode: process.env.WORKFLOW_MODE ?? 'mock',
    baseUrl: process.env.WORKFLOW_BASE_URL ?? '',
    channelId: process.env.WORKFLOW_CHANNEL_ID ?? '',
    channelKey: process.env.WORKFLOW_CHANNEL_KEY ?? '',
    organizationId: process.env.WORKFLOW_ORGANIZATION_ID ?? 'osd-company',
    workspaceId: process.env.WORKFLOW_WORKSPACE_ID ?? 'default',
    retryIntervalMs: 0,
  },
  /** CD-65 ดีลเงียบ — the sweep is core-service's, like every clock above. */
  crm: {
    /** CD-162 — expiry reminders for contracts without a renewal deal (ms); 0 = off. */
    contractExpiryIntervalMs: 0,
    obligationIntervalMs: 0,
    /** CD-78 — expire/release number holds, warn owners (ms); 0 = off. */
    phoneReservationIntervalMs: 0,
    staleSweepIntervalMs: 0,
    // CD-61 — the KYC expiry sweep is core-service's too.
    kycExpiryIntervalMs: 0,
    // CD-70 — renewals are core-service's too.
    contractRenewalIntervalMs: 0,
    // CD-53 — overdue-invoice reminders too.
    invoiceOverdueIntervalMs: 0,
    // CD-86 — account review reminders too.
    accountReviewIntervalMs: 0,
  },
  pdpa: {
    mode: process.env.PDPA_MODE ?? 'mock',
    baseUrl: process.env.PDPA_BASE_URL ?? '',
    apiKey: process.env.PDPA_API_KEY ?? '',
  },
});
