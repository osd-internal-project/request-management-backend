import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AppError,
  COMPANY_HEADER,
  firstFreeCode,
  type RunNumberDocType,
} from '@request-management/share';
import { ApiKeyService } from '../principal/api-key.service';
import { CompanyPrefixRepository } from './company-prefix.repository';

/** เท่ากับที่ `RemotePrincipalService` ให้ user-service — hop ภายในเครือข่ายเดียวกัน. */
const TIMEOUT_MS = 20_000;

export interface IssueRunNumberInput {
  readonly companyId: string;
  readonly docType: RunNumberDocType;
  /** `typeCode` ของคำขอ หรือ `*` เมื่อชนิดเอกสารนั้นไม่มีขอบเขตย่อย. */
  readonly scopeKey?: string;
  readonly master?: Readonly<Record<string, string>>;
  /**
   * คีย์ที่ทำให้การยิงซ้ำได้เลขเดิม — ใส่เมื่อมีตัวระบุที่คงที่ข้าม retry.
   * เอกสารใหม่ที่ยังไม่มี id ไม่ต้องใส่ `IdempotencyInterceptor` คุมชั้นนอกแล้ว.
   */
  readonly idempotencyKey?: string;
}

interface IssueResponse {
  number: string;
  seq: number;
  pattern: string;
  periodKey: string;
}

/**
 * ขอเลขรันจาก run-number-service ด้วย service-account token ของ core เอง.
 * ออกเลขนอก transaction ของผู้เรียก — docs/run-number.md.
 */
@Injectable()
export class RunNumberClient {
  private readonly logger = new Logger(RunNumberClient.name);

  constructor(
    private readonly config: ConfigService,
    private readonly tokens: ApiKeyService,
    private readonly companies: CompanyPrefixRepository,
  ) {}

  /** เลขเดียว หนึ่ง hop. */
  async issue(input: IssueRunNumberInput): Promise<string> {
    const response = await this.post(input);
    return response.number;
  }

  /**
   * เลขแรกที่ `isTaken` บอกว่ายังไม่มีใครถือ.
   * วนที่นี่ไม่ใช่ที่ run-number-service เพราะตารางเอกสารอยู่ที่นี่.
   */
  async issueUnused(
    input: IssueRunNumberInput,
    isTaken: (code: string) => Promise<boolean>,
  ): Promise<string> {
    let attempt = 0;

    return firstFreeCode(
      `run number ${input.docType} ของบริษัท ${input.companyId}`,
      () =>
        this.issue({
          ...input,
          idempotencyKey: input.idempotencyKey
            ? `${input.idempotencyKey}:${attempt++}`
            : undefined,
        }),
      isTaken,
    );
  }

  private async post(input: IssueRunNumberInput): Promise<IssueResponse> {
    const baseUrl = this.config.get<string>('runNumberServiceUrl')!;
    const url = `${baseUrl}/internal/run-numbers/issue`;
    const company = (await this.companies.findUnique({
      where: { id: input.companyId },
      select: { code: true, docPrefix: true },
    })) as { code: string; docPrefix: string } | null;

    if (!company) {
      throw new AppError('NOT_FOUND', 'ไม่พบบริษัทของเอกสารนี้', [
        { field: 'companyId', reason: input.companyId },
      ]);
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${await this.tokens.integrationToken()}`,
          'content-type': 'application/json',
          [COMPANY_HEADER]: input.companyId,
          ...(input.idempotencyKey
            ? { 'idempotency-key': input.idempotencyKey }
            : {}),
        },
        body: JSON.stringify({
          doc_type: input.docType,
          scope_key: input.scopeKey ?? '*',
          company_prefix: company.docPrefix,
          company_code: company.code,
          master: input.master,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      this.logger.error(
        `Cannot reach run-number-service at ${url}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
      throw new AppError('UNKNOWN', 'ไม่สามารถออกเลขที่เอกสารได้ในขณะนี้');
    }

    if (!response.ok) {
      // สถานะจากปลายทางติดไปใน details — กรณีที่เกิดจริงคือรูปแบบต้องการตัวแปรที่ขาด
      const body = await response.text();
      this.logger.error(`run-number-service ${response.status}: ${body}`);

      throw new AppError('UNKNOWN', 'ออกเลขที่เอกสารไม่สำเร็จ', [
        { field: 'run-number-service', reason: `${response.status}` },
      ]);
    }

    return (await response.json()) as IssueResponse;
  }
}
