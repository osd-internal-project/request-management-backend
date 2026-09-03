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
   * The workflow engine (Flowable), and the URL it calls back on.
   *
   * `callbackUrl` is baked into every BPMN generated at publish, so it must be
   * how Flowable reaches core-service — a container name, not `localhost`,
   * wherever the two run in separate containers. Changing it does not rewrite
   * definitions already deployed; those keep the URL they were published with,
   * which is deliberate (a running instance keeps the rules it started under)
   * and means a move needs the affected types republished.
   */
  flowable: {
    baseUrl:
      process.env.FLOWABLE_BASE_URL ??
      'http://localhost:8080/flowable-rest/service',
    user: process.env.FLOWABLE_USER ?? 'rest-admin',
    password: process.env.FLOWABLE_PASSWORD ?? '',
    callbackUrl:
      process.env.FLOWABLE_CALLBACK_URL ??
      'http://localhost:3002/api/v1/internal/workflow/callback',
    /**
     * The shared secret the callback route demands.
     *
     * The callback is the one route the engine calls, and the engine cannot
     * hold a Keycloak token — a BPMN http task would have to fetch one first,
     * which means the client secret ends up inside deployed process XML. A
     * shared secret in a header is the smaller exposure, and the route is
     * reachable only from inside the deployment's own network.
     *
     * Empty in local dev means the guard refuses everything, which is the
     * correct default: a callback route with no secret is an unauthenticated
     * write endpoint onto every request in the system.
     */
    callbackSecret: process.env.FLOWABLE_CALLBACK_SECRET ?? '',
  },

  /**
   * CD-92: the embedded BI menu. `siteUrl` is where browsers reach Metabase;
   * `embedSecret` is Metabase's "embedding secret key" (Admin → Embedding) —
   * signing with it is what lets an app login stand in for a Metabase login.
   * Dashboard ids come from the Metabase URL after each dashboard is created.
   */
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
