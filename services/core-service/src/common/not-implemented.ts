import { AppError } from '@request-management/share';

/**
 * Marks a route that exists on purpose but has no behaviour yet.
 *
 * The S2/S3 endpoints are declared now so the URL shape, the permission each
 * one requires, and the generated OpenAPI are settled before anyone builds
 * against them — a frontend or an integration can be written to the real
 * contract while the body is still being filled in. A 501 with the owning
 * requirement code says plainly which sprint delivers it.
 */
export function notImplemented(requirement: string): never {
  throw new AppError(
    'NOT_IMPLEMENTED',
    `ยังไม่เปิดใช้งานใน sprint นี้ (${requirement})`,
    [{ field: 'requirement', reason: requirement }],
  );
}
