export default () => ({
  env: process.env.NODE_ENV ?? 'local',
  port: Number(process.env.CORE_SERVICE_PORT ?? process.env.PORT ?? 3002),
  serviceName: 'core-service',

  /**
   * Where to resolve callers. core-service holds no identity tables of its
   * own — it asks user-service (§03).
   */
  userServiceUrl: process.env.USER_SERVICE_URL ?? 'http://localhost:3001',
});
