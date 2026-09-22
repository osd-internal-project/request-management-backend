export default () => ({
  env: process.env.NODE_ENV ?? 'local',
  port: Number(process.env.RUN_NUMBER_SERVICE_PORT ?? process.env.PORT ?? 3004),
  serviceName: 'run-number-service',

  /**
   * ที่ที่ resolve ผู้เรียก เหมือน core-service และ external-service: service นี้
   * ไม่มีตารางตัวตนและไม่ตรวจ token เอง — user-service ทำ (§03).
   */
  userServiceUrl:
    process.env.USER_SERVICE_URL ?? 'http://localhost:3001/api/v1',
});
