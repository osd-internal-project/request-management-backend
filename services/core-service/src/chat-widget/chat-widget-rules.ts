import { AppError } from '@request-management/share';

/**
 * A widget URL as stored: its origin only, or null for "use the env". v1.js
 * builds its iframe and postMessage target from the script's origin, so a
 * path would be dropped anyway; the scheme must match the slot because an
 * https page cannot load an http script (mixed content).
 */
export function widgetOrigin(
  value: string | null | undefined,
  protocol: 'http:' | 'https:',
): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new AppError('VALIDATION_FAILED', `URL ไม่ถูกต้อง: ${trimmed}`);
  }
  if (url.protocol !== protocol) {
    throw new AppError(
      'VALIDATION_FAILED',
      `ช่องนี้ต้องขึ้นต้นด้วย ${protocol}// (ได้ ${url.protocol}//)`,
    );
  }
  return url.origin;
}
