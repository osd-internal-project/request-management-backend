export default () => ({
  env: process.env.NODE_ENV ?? 'local',
  port: Number(process.env.USER_SERVICE_PORT ?? process.env.PORT ?? 3001),
  serviceName: 'user-service',
});
