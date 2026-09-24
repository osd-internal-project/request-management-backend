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
   * CM-06/D-30 — the ERP (SAP) integration layer. `mode=mock` (default, the
   * only driver until the SAP connection method is settled) runs the
   * in-memory stand-in so every environment works end-to-end; any other mode
   * fails at boot. The SAP driver's credentials join this block when it lands.
   * Intervals in ms; 0 disables the background timers (tests).
   */
  erp: {
    mode: process.env.ERP_MODE ?? 'mock',
    retryIntervalMs: Number(process.env.ERP_RETRY_INTERVAL_MS ?? 300000),
    refreshIntervalMs: Number(process.env.ERP_REFRESH_INTERVAL_MS ?? 3600000),
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
  crm: {
    staleSweepIntervalMs: Number(
      process.env.CRM_STALE_SWEEP_INTERVAL_MS ?? 3600000,
    ),
  },

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
});
