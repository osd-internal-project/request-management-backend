import { AppError } from '@request-management/share';

/** The SIP fields of an extension as stored. */
export interface SipSettings {
  extension: string;
  wssUrl: string;
  sipServer: string;
}

/**
 * The admin's input as stored, with every rule an extension must keep. SIP.js
 * opens its WebSocket from the browser, so an `ws://` URL is refused: an https
 * page cannot open one (mixed content).
 */
export function sipSettings(input: {
  extension: string;
  wss_url: string;
  sip_server: string;
}): SipSettings {
  const extension = input.extension.trim();
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(extension)) {
    throw new AppError(
      'VALIDATION_FAILED',
      'เลขต่อใช้ได้เฉพาะตัวอักษร ตัวเลข . _ - (ไม่เกิน 64 ตัว)',
    );
  }
  const sipServer = input.sip_server.trim();
  if (!/^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(sipServer)) {
    throw new AppError(
      'VALIDATION_FAILED',
      'SIP server ต้องเป็น host หรือ host:port เช่น 10.0.0.5',
    );
  }
  let url: URL;
  try {
    url = new URL(input.wss_url.trim());
  } catch {
    throw new AppError('VALIDATION_FAILED', 'WebSocket URL ไม่ถูกต้อง');
  }
  if (url.protocol !== 'wss:') {
    throw new AppError(
      'VALIDATION_FAILED',
      `WebSocket URL ต้องขึ้นต้นด้วย wss:// (ได้ ${url.protocol}//)`,
    );
  }
  return { extension, wssUrl: url.toString(), sipServer };
}

/** Whole seconds between answer and hang-up; refuses an end before the start. */
export function callSeconds(answeredAt: Date, endedAt: Date): number {
  const ms = endedAt.getTime() - answeredAt.getTime();
  if (Number.isNaN(ms) || ms < 0) {
    throw new AppError(
      'VALIDATION_FAILED',
      'เวลาวางสายต้องไม่ก่อนเวลารับสาย',
    );
  }
  return Math.round(ms / 1000);
}
