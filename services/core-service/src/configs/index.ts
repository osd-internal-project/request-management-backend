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
  integration: {
    clientId: process.env.INTEGRATION_CLIENT_ID ?? '',
    clientSecret: process.env.INTEGRATION_CLIENT_SECRET ?? '',
  },

  /**
   * Where callers outside this machine reach core-service.
   *
   * Needed only by the MCP OAuth discovery document, which has to state its
   * own address: a client is told "this resource lives at X, authorise at Y",
   * and X must be the URL *it* used, not `localhost`. Everything else in this
   * service answers on whatever host the request arrived at and never has to
   * name itself.
   *
   * Docker maps 3502 → 3002 (`infra/labs/docker-compose.yml`), so the default
   * is the port a caller on the network actually uses.
   */
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? 'http://192.168.31.52:3502',

  /**
   * CD-92: the embedded BI menu. `siteUrl` is where browsers reach Metabase;
   * `embedSecret` is Metabase's "embedding secret key" (Admin → Embedding) —
   * signing with it is what lets an app login stand in for a Metabase login.
   * Dashboard ids come from the Metabase URL after each dashboard is created.
   */
  /**
   * CM-06/D-30 — the Odoo integration layer. `mode=mock` (default) runs the
   * in-memory stand-in so every environment works before the sandbox exists;
   * point `mode=http` + the four credentials at the sandbox when it arrives.
   * Intervals in ms; 0 disables the background timers (tests).
   */
  odoo: {
    mode: process.env.ODOO_MODE ?? 'mock',
    baseUrl: process.env.ODOO_BASE_URL ?? '',
    db: process.env.ODOO_DB ?? '',
    uid: Number(process.env.ODOO_UID ?? 0),
    apiKey: process.env.ODOO_API_KEY ?? '',
    retryIntervalMs: Number(process.env.ODOO_RETRY_INTERVAL_MS ?? 300000),
    refreshIntervalMs: Number(process.env.ODOO_REFRESH_INTERVAL_MS ?? 3600000),
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
