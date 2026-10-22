import { Injectable, Logger } from '@nestjs/common';
import { IntegrationCallRepository } from './integration-call.repository';

export type IntegrationCallMode =
  'app' | 'user_token' | 'acting_user' | 'person';

/** คำขอหนึ่งครั้ง ตามที่ external-service เห็นตอนตอบเสร็จ. */
export interface IntegrationCallEntry {
  integrationId: string | null;
  apiKeyId: string | null;
  companyId: string | null;
  method: string;
  route: string;
  mode: IntegrationCallMode;
  actorUserId: string | null;
  status: number;
  durationMs: number;
}

/**
 * เขียน `integration_calls` — ไม่ทำให้คำขอที่บันทึกล้ม: เขียนไม่ได้ = warn ใน log
 * แบบเดียวกับ `McpCallLogService`.
 */
@Injectable()
export class IntegrationCallLogService {
  private readonly logger = new Logger(IntegrationCallLogService.name);

  constructor(private readonly calls: IntegrationCallRepository) {}

  async record(entry: IntegrationCallEntry): Promise<void> {
    try {
      await this.calls.create({
        data: {
          ...entry,
          durationMs: Math.max(0, Math.round(entry.durationMs)),
        },
      });
    } catch (error) {
      this.logger.warn(
        `integration call not logged (${entry.method} ${entry.route}): ${(error as Error).message}`,
      );
    }
  }
}
