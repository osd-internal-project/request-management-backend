import { parseCompanyDbs } from '../erp/sap-b1.config';

export default () => ({
  env: process.env.NODE_ENV ?? 'local',
  port: Number(process.env.CORE_SERVICE_PORT ?? process.env.PORT ?? 3002),
  serviceName: 'core-service',

  /**
   * Where to resolve callers. core-service holds no identity tables of its
   * own — it asks user-service (§03).
   */
  userServiceUrl:
    process.env.USER_SERVICE_URL ?? 'http://localhost:3001/api/v1',

  /**
   * ที่ที่ขอเลขรันทุกชนิดเอกสาร (REQ-02 / CM-02).
   *
   * service นี้ต้องขึ้นก่อน core-service — ถ้ามันไม่ตอบ การสร้างเอกสารทุกชนิด
   * จะล้มพร้อมกัน ไม่ใช่แค่ช้าลง. นั่นคือราคาของการแยกเลขรันออกไป deploy เอง
   * และเป็นเหตุที่ลำดับ deploy ต้องเขียนไว้ใน PR.
   */
  runNumberServiceUrl:
    process.env.RUN_NUMBER_SERVICE_URL ?? 'http://localhost:3004/api/v1',

  /**
   * AUTH-06: what an API key is exchanged for.
   *
   * core-service does not verify tokens (§03) and does not start doing so here.
   * It mints one: a key resolves to a Keycloak client-credentials token for
   * this client, which is then forwarded exactly as a caller-supplied token
   * would be, so user-service remains the only verifier.
   *
   * The realm details are duplicated from user-service's `keycloak.config.ts`
   * rather than imported, because the two services are deployed separately and
   * neither imports the other's modules.
   */
  keycloak: {
    baseUrl: process.env.KEYCLOAK_BASE_URL ?? 'http://192.168.31.51:8180',
    realm: process.env.KEYCLOAK_REALM ?? 'enterprise-request',
  },
  /**
   * Still here after the external API moved to external-service, because
   * `RemotePrincipalGuard` is global and still exchanges an `rfk_` key for a
   * token if one is presented.
   *
   * Left deliberately rather than removed. A key *can* still authenticate
   * here, and then does nothing: `PolicyGuard` refuses a service account on
   * any route that declares neither `@ServiceAccountOnly` nor
   * `@ServiceAccountAllowed`, and after the move this service has no such
   * business route left. Removing the exchange would be a second, different
   * answer to the same credential — `UNAUTHORIZED` instead of `FORBIDDEN` —
   * for no gain.
   *
   * The admin screen that *issues* keys lives here too
   * (`PrincipalHttpModule`), and that is the right place for it: minting a
   * credential is an internal act.
   */
  integration: {
    clientId: process.env.INTEGRATION_CLIENT_ID ?? '',
    clientSecret: process.env.INTEGRATION_CLIENT_SECRET ?? '',
  },

  /**
   * CD-92: the embedded BI menu. `siteUrl` is where browsers reach Metabase;
   * `embedSecret` is Metabase's "embedding secret key" (Admin → Embedding) —
   * signing with it is what lets an app login stand in for a Metabase login.
   * Dashboard ids come from the Metabase URL after each dashboard is created.
   */
  /**
   * CM-06/D-30 — the ERP (SAP B1) integration layer. `mode=mock` (default)
   * runs the in-memory stand-in so every environment works end-to-end;
   * `mode=sapb1` talks to the Service Layer below. Intervals in ms; 0
   * disables the background timers (tests).
   */
  /** CD-78 — Reserve-phone (the phone number inventory); only `mock` exists yet. */
  /**
   * CD-14 ระบบลงนามอิเล็กทรอนิกส์. `publicUrl` is where the signing links and
   * the verification page live (the web app); `secret` keys the one-time
   * codes' hashes — set it in every environment.
   */
  esign: {
    publicUrl: process.env.ESIGN_PUBLIC_URL ?? 'http://localhost:3000',
    secret:
      process.env.ESIGN_SECRET ??
      (process.env.NODE_ENV === 'production' ? undefined : 'dev-esign-secret'),
    /** mock (log only) until SMTP / SMS exist */
    senderMode: process.env.ESIGN_SENDER_MODE ?? 'mock',
    /** CD-171 — reminders / expiry sweep (0 = off, e.g. in tests). */
    sweepIntervalMs: Number(process.env.ESIGN_SWEEP_INTERVAL_MS ?? 3_600_000),
  },
  /** CD-217 — the key project configuration secrets are encrypted with. */
  projectConfig: {
    secret:
      process.env.CONFIG_SECRET_KEY ??
      (process.env.NODE_ENV === 'production'
        ? undefined
        : 'dev-project-config-secret'),
  },
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
    deliveryIntervalMs: Number(process.env.TEAMS_DELIVERY_INTERVAL_MS ?? 15000),
  },
  erp: {
    mode: process.env.ERP_MODE ?? 'mock',
    retryIntervalMs: Number(process.env.ERP_RETRY_INTERVAL_MS ?? 300000),
    refreshIntervalMs: Number(process.env.ERP_REFRESH_INTERVAL_MS ?? 3600000),
    /** CD-27 — ดึงรายการสินค้าจาก SAP (และครั้งแรก ~15 วินาทีหลัง start). */
    itemsRefreshIntervalMs: Number(
      process.env.ERP_ITEMS_REFRESH_INTERVAL_MS ?? 3600000,
    ),
    /** CD-206 — ต้นทุนคู่ค้า (ใบสั่งซื้อ + ราคาพิเศษผู้ขาย) จาก SAP; ค่าตั้งต้นทุก 6 ชั่วโมง. */
    vendorCostsRefreshIntervalMs: Number(
      process.env.ERP_VENDOR_COSTS_REFRESH_INTERVAL_MS ?? 21600000,
    ),
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
  },

  /**
   * OSD Workflow (workflowable) — เจ้าของ *process* ของ CRM ตั้งแต่
   * 10 ก.ย. 2569. `mode=mock` (ค่าตั้งต้น) ใช้สแตนด์อินในหน่วยความจำ เพื่อให้
   * ทุกสภาพแวดล้อมทำงานได้โดยไม่ต้องต่อของจริง.
   *
   * `channelKey` คือคีย์ของ channel ชนิด APPLICATION_API บน `lwf-0001` —
   * หมุนได้จากหน้าจอ Channels ของแพลตฟอร์ม ไม่ต้อง deploy. `workspaceId` เป็น
   * `default` ตามที่ curl ของ channel ระบุ ไม่ใช่ชื่อทีมที่หน้าจอโชว์.
   */
  workflow: {
    mode: process.env.WORKFLOW_MODE ?? 'mock',
    baseUrl: process.env.WORKFLOW_BASE_URL ?? '',
    channelId: process.env.WORKFLOW_CHANNEL_ID ?? '',
    channelKey: process.env.WORKFLOW_CHANNEL_KEY ?? '',
    organizationId: process.env.WORKFLOW_ORGANIZATION_ID ?? 'osd-company',
    workspaceId: process.env.WORKFLOW_WORKSPACE_ID ?? 'default',
    retryIntervalMs: Number(process.env.WORKFLOW_RETRY_INTERVAL_MS ?? 300000),
  },

  /** CD-65 — รอบตรวจโอกาสการขายที่เงียบเกินเกณฑ์ (ms); 0 = ปิด (tests). */
  hr: {
    /** CD-233 — manday plan-vs-actual steps and closing summaries (ms); 0 = off. */
    mandayVarianceIntervalMs: Number(
      process.env.HR_MANDAY_VARIANCE_INTERVAL_MS ?? 21600000,
    ),
  },

  crm: {
    /** CD-162 — expiry reminders for contracts without a renewal deal (ms); 0 = off. */
    contractExpiryIntervalMs: Number(
      process.env.CRM_CONTRACT_EXPIRY_INTERVAL_MS ?? 3600000,
    ),
    /** CD-163 — obligation due/overdue reminders (ms); 0 = off. */
    obligationIntervalMs: Number(
      process.env.CRM_OBLIGATION_INTERVAL_MS ?? 3600000,
    ),
    /** CD-78 — expire/release number holds, warn owners (ms); 0 = off. */
    phoneReservationIntervalMs: Number(
      process.env.CRM_PHONE_RESERVATION_INTERVAL_MS ?? 3600000,
    ),
    staleSweepIntervalMs: Number(
      process.env.CRM_STALE_SWEEP_INTERVAL_MS ?? 3600000,
    ),
    /** CD-61 — KYC expiry warnings and expiry (ms); 0 = off (tests). */
    kycExpiryIntervalMs: Number(
      process.env.CRM_KYC_EXPIRY_INTERVAL_MS ?? 3600000,
    ),
    /** CD-70 — contract renewal deals and reminders (ms); 0 = off (tests). */
    contractRenewalIntervalMs: Number(
      process.env.CRM_CONTRACT_RENEWAL_INTERVAL_MS ?? 3600000,
    ),
    /** CD-53 — overdue SAP invoices; a pass runs once a Bangkok day (ms); 0 = off. */
    /** CD-86 — account review reminders (ms); 0 = off. */
    accountReviewIntervalMs: Number(
      process.env.CRM_ACCOUNT_REVIEW_INTERVAL_MS ?? 3600000,
    ),
    invoiceOverdueIntervalMs: Number(
      process.env.CRM_INVOICE_OVERDUE_INTERVAL_MS ?? 3600000,
    ),
  },
  pm: {
    /** CD-192 — weekly status report drafts, refreshed daily (ms); 0 = off. */
    statusReportIntervalMs: Number(
      process.env.PM_STATUS_REPORT_INTERVAL_MS ?? 3600000,
    ),
    /** CD-190 — ERP project costs + budget thresholds (ms); 0 = off. */
    costSweepIntervalMs: Number(
      process.env.PM_COST_SWEEP_INTERVAL_MS ?? 21600000,
    ),
  },
  /** CD-52 — how often due daily digests are looked for (ms); 0 = off (tests). */
  notificationDigestIntervalMs: Number(
    process.env.NOTIFICATION_DIGEST_INTERVAL_MS ?? 300000,
  ),

  /**
   * CD-90 — the Data Lake: a separate PostgreSQL warehouse database. Unset =
   * no lake, nothing runs. Changed rows every hour, SAP invoices daily.
   */
  lake: {
    databaseUrl: process.env.LAKE_DATABASE_URL ?? '',
    extractIntervalMs: Number(process.env.LAKE_EXTRACT_INTERVAL_MS ?? 3600000),
    sapIntervalMs: Number(process.env.LAKE_SAP_INTERVAL_MS ?? 86400000),
  },

  /** CD-91 — how often the Data Mart is rebuilt (ms); 0 = off (tests). */
  martRefreshIntervalMs: Number(
    process.env.MART_REFRESH_INTERVAL_MS ?? 3600000,
  ),

  /** CM-05/D-35 — the PDPA integration layer; mock until the central
   * service (DPO-owned) exists. */
  pdpa: {
    mode: process.env.PDPA_MODE ?? 'mock',
    baseUrl: process.env.PDPA_BASE_URL ?? '',
    apiKey: process.env.PDPA_API_KEY ?? '',
  },

  metabase: {
    siteUrl: process.env.METABASE_SITE_URL ?? '',
    embedSecret: process.env.METABASE_EMBED_SECRET ?? '',
    dashboards: {
      requestOverview: Number(process.env.METABASE_DASHBOARD_REQUEST ?? 0),
      approval: Number(process.env.METABASE_DASHBOARD_APPROVAL ?? 0),
      sla: Number(process.env.METABASE_DASHBOARD_SLA ?? 0),
    },
  },

  /**
   * ที่เก็บไฟล์แนบ (REQ-03) — `minio` ต่อ MinIO จริง · `memory` เก็บใน process
   * ใช้ตอน dev/test ที่ไม่มี MinIO. S3 เจ้าอื่นในอนาคต = เพิ่ม mode ใหม่ใน libs/share.
   */
  storage: {
    mode: process.env.STORAGE_MODE ?? 'minio',
    minio: {
      endPoint: process.env.MINIO_ENDPOINT ?? '',
      port: Number(process.env.MINIO_PORT ?? 9000),
      useSSL: process.env.MINIO_USE_SSL === 'true',
      accessKey: process.env.MINIO_ACCESSKEY ?? '',
      secretKey: process.env.MINIO_SECRETKEY ?? '',
      bucket: process.env.MINIO_BUCKET ?? '',
    },
  },
});
