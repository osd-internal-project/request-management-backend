import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppError } from '@request-management/share';

export interface ApprovalContext {
  supervisorUserId: string | null;
  supervisorChain: string[];
  roleHolders: Record<string, string>;
  /** `userId` → display name, so a chain can be shown before it is opened. */
  displayNames: Record<string, string>;
}

/**
 * Reads the approval context from user-service.
 *
 * core-service owns no identity tables — `GET /internal/org/approval-context`
 * is the named contract for "who reports to whom, and who holds which office".
 * Deliberately **not cached**: an org change must take effect on the next
 * submit, and a stale supervisor would route a case to the wrong person with
 * no sign that anything was wrong.
 */
@Injectable()
export class ApprovalContextClient {
  private readonly logger = new Logger(ApprovalContextClient.name);

  constructor(private readonly config: ConfigService) {}

  async resolve(
    authorization: string,
    userId: string,
    companyId: string,
  ): Promise<ApprovalContext> {
    const base =
      this.config.get<string>('services.userServiceUrl') ??
      'http://localhost:3001/api/v1';

    const url =
      `${base}/internal/org/approval-context` +
      `?user_id=${encodeURIComponent(userId)}` +
      `&company_id=${encodeURIComponent(companyId)}`;

    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Authorization: authorization, 'X-Company-Id': companyId },
      });
    } catch (error) {
      this.logger.error(
        `approval-context unreachable: ${error instanceof Error ? error.message : ''}`,
      );
      throw new AppError(
        'UNKNOWN',
        'ไม่สามารถอ่านผังทีมเพื่อคำนวณสายอนุมัติได้',
      );
    }

    if (!response.ok) {
      this.logger.warn(`approval-context returned HTTP ${response.status}`);
      throw new AppError(
        'UNKNOWN',
        'ไม่สามารถอ่านผังทีมเพื่อคำนวณสายอนุมัติได้',
      );
    }

    return (await response.json()) as ApprovalContext;
  }
}
