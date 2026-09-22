// logger.middleware.ts
import { Request, Response, NextFunction } from 'express';

/*
  The container's own HEALTHCHECK wgets this path every 15s, which buries real
  traffic in `docker logs`. The endpoint still answers; it just stops narrating.
*/
const SILENT_PATHS = new Set(['/api/v1/health']);

export function logger(req: Request, res: Response, next: NextFunction) {
  const [path] = req.url.split('?');

  if (!SILENT_PATHS.has(path)) {
    console.log(`[${req.method}] ${req.url}`);
  }

  next();
}
