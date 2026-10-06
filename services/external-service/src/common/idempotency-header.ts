/**
 * `Idempotency-Key` as the post-deal write routes document it — the same
 * wording `request.controller.ts` gives its two POSTs, for the same reason:
 * the interceptor is inert without the header, so it is optional, but a
 * retried POST without it opens a second project or a second service job.
 */
export const IDEMPOTENCY_KEY_HEADER = {
  name: 'Idempotency-Key',
  required: false,
  description:
    'ควรส่งทุกครั้ง — หนึ่งค่าต่อหนึ่งเจตนา ' +
    'ยิงซ้ำด้วยค่าเดิมและ body เดิมจะได้ผลลัพธ์เดิมกลับไป ไม่เกิดรายการที่สอง',
  schema: {
    type: 'string',
    example: '6f6bd3a7-7308-4d2e-a4de-75e1f89b6871',
  },
} as const;
