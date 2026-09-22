import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, Response } from 'express';

interface RequestContext {
  /** header `authorization` ตามที่มาถึง ก่อน guard ใด ๆ แก้ */
  readonly authorization: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * เก็บ credential ของคำขอไว้ให้โค้ดชั้นในหยิบไปเรียก service อื่นต่อ.
 * ต้องลงทะเบียนก่อน guard ทุกตัว — `app.use()` ใน `main.ts`.
 */
export function requestContextMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const authorization = req.headers.authorization;

  if (typeof authorization !== 'string' || !authorization) {
    next();
    return;
  }

  storage.run({ authorization }, next);
}

/**
 * credential ของคำขอที่กำลังทำงานอยู่ — `undefined` เมื่อไม่ได้อยู่ในคำขอ.
 * ส่งต่อดิบ ๆ ทั้ง token ของคนและกุญแจ `rfk_` ปลายทางจึงตีความได้เหมือนกัน.
 */
export function currentAuthorization(): string | undefined {
  return storage.getStore()?.authorization;
}
