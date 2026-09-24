import type { Logger } from '@nestjs/common';

/**
 * A timer callback for background work (queue sweeps, SAP refresh, stale
 * scans). `setInterval(() => void work())` lets a rejection escape as an
 * unhandled rejection, and Node exits on those — a database blip took the whole
 * core-service down on 24 Sep 2026. A failed tick is only logged: the next tick
 * is the retry.
 */
export function backgroundTick(
  logger: Pick<Logger, 'warn'>,
  label: string,
  work: () => Promise<unknown>,
): () => void {
  return () => {
    void work().catch((error: unknown) => {
      logger.warn(
        `${label} failed, next round retries: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  };
}
