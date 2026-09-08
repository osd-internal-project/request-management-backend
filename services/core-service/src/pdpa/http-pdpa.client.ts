import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppError } from '@request-management/share';
import {
  ContactConsentQuery,
  ContactConsentStatus,
  PdpaClient,
} from './pdpa-client';

/**
 * The real driver (PDPA_MODE=http) — written before the central PDPA service
 * exists, so `POST {base}/consents/lookup` is this system's PROPOSED contract
 * for that service, not a settled one. Adjust here when the DPO's team lands
 * theirs; nothing outside this file knows the wire shape.
 */
@Injectable()
export class HttpPdpaClient implements PdpaClient {
  readonly mode = 'http' as const;
  private readonly logger = new Logger(HttpPdpaClient.name);

  constructor(private readonly config: ConfigService) {}

  async lookupConsents(
    queries: readonly ContactConsentQuery[],
  ): Promise<ContactConsentStatus[]> {
    const baseUrl = this.config.get<string>('pdpa.baseUrl');
    const apiKey = this.config.get<string>('pdpa.apiKey');

    if (!baseUrl) {
      throw new AppError(
        'UPSTREAM_ERROR',
        'PDPA_MODE=http แต่ยังไม่ได้ตั้งค่า PDPA_BASE_URL',
      );
    }

    const response = await fetch(`${baseUrl}/consents/lookup`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        subjects: queries.map((query) => ({
          ref: query.contactId,
          email: query.email ?? null,
          phone: query.phone ?? null,
        })),
      }),
    });

    if (!response.ok) {
      this.logger.warn(`pdpa lookup answered HTTP ${response.status}`);
      throw new AppError(
        'UPSTREAM_ERROR',
        `บริการ PDPA กลางตอบ HTTP ${response.status}`,
      );
    }

    const body = (await response.json()) as {
      results: {
        ref: string;
        email?: ContactConsentStatus['email'];
        phone?: ContactConsentStatus['phone'];
        do_not_call?: boolean;
      }[];
    };

    return queries.map((query) => {
      const row = body.results.find((r) => r.ref === query.contactId);
      return {
        contactId: query.contactId,
        email: query.email ? (row?.email ?? 'unknown') : null,
        phone: query.phone ? (row?.phone ?? 'unknown') : null,
        doNotCall: row?.do_not_call ?? false,
      };
    });
  }
}
