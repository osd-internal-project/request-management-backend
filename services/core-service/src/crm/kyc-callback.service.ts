import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { KycRiskLevel, Prisma } from '@prisma/client';
import { AuditWriter } from '@request-management/share';
import { DomainEventsService } from '../events/domain-events.service';
import { DOMAIN_EVENTS } from '../events/event-catalog';
import { RequestRepository } from '../requests/request.repository';
import { CustomerRepository } from './customer.repository';
import { CustomerFieldChangeRepository } from './customer-child.repositories';
import { CustomerTimelineService } from './customer-timeline.service';
import {
  CustomerKycRecordRepository,
  KycWatchlistRepository,
} from './kyc.repositories';
import {
  bangkokDay,
  kycDates,
  readReviewerAnswers,
  screenAgainst,
  suggestRisk,
  type WatchlistEntry,
} from './kyc-rules';
import { CrmConfigRepository } from './segment.repositories';

const RISK_TH: Record<KycRiskLevel, string> = {
  low: 'ต่ำ',
  medium: 'กลาง',
  high: 'สูง',
};

interface CompletedKyc {
  id: string;
  requestNo: string | null;
  refType: string | null;
  refId: string | null;
  receiverFormData: unknown;
  assigneeUserId: string | null;
  receiverUserId: string | null;
  requestType: { requiredDocs: unknown } | null;
  attachments: { docCode: string | null; deletedAt: Date | null }[];
}

/**
 * CM-04 / CD-61 — a completed KYC request verifies the customer it names.
 *
 * Since CD-61 a verification is a record, not only a flag: the customer is
 * screened against the company's prohibited list at that moment, the
 * reviewer's form (the KYC type's receiver form) supplies the risk level,
 * the earliest document expiry and the signatories, and the review date
 * follows from the risk level (CRM settings). The record is kept; the
 * customer's `kycVerified` / `kycRiskLevel` / `kycExpiresOn` summarise the
 * latest verified one.
 *
 * A list match with no clearance note in the reviewer's form is recorded as
 * `screening_hit` and does **not** verify (user decision 29 ก.ย. 2569: a
 * match must be cleared by someone with authority). A risk the reviewer left
 * empty is the system's suggestion.
 *
 * Idempotent by request: a re-emitted event finds the record and stops.
 */
@Injectable()
export class KycCallbackService implements OnModuleInit {
  private readonly logger = new Logger(KycCallbackService.name);

  constructor(
    private readonly events: DomainEventsService,
    private readonly requests: RequestRepository,
    private readonly customers: CustomerRepository,
    private readonly fieldChanges: CustomerFieldChangeRepository,
    private readonly timeline: CustomerTimelineService,
    private readonly audit: AuditWriter,
    private readonly records: CustomerKycRecordRepository,
    private readonly watchlist: KycWatchlistRepository,
    private readonly configs: CrmConfigRepository,
  ) {}

  onModuleInit(): void {
    this.events.on(DOMAIN_EVENTS.requestCompleted, (event) =>
      this.onRequestCompleted(
        event.payload as { request_id: string; type_code: string },
      ),
    );
  }

  async onRequestCompleted(
    payload: { request_id: string; type_code: string },
    now: Date = new Date(),
  ): Promise<void> {
    if (payload.type_code !== 'KYC') return;

    const request = (await this.requests.findFirst({
      where: { id: payload.request_id },
      select: {
        id: true,
        requestNo: true,
        refType: true,
        refId: true,
        receiverFormData: true,
        assigneeUserId: true,
        receiverUserId: true,
        requestType: { select: { requiredDocs: true } },
        attachments: { select: { docCode: true, deletedAt: true } },
      },
    })) as CompletedKyc | null;

    if (request?.refType !== 'customer' || !request.refId) {
      this.logger.warn(
        `KYC request ${payload.request_id} completed without a customer ref — nothing to verify`,
      );
      return;
    }

    const customer = (await this.customers.findFirst({
      where: { id: request.refId, mergedIntoCustomerId: null },
      select: {
        id: true,
        companyId: true,
        customerCode: true,
        nameTh: true,
        nameEn: true,
        taxId: true,
        kycVerified: true,
        kycRiskLevel: true,
        kycExpiresOn: true,
      },
    })) as {
      id: string;
      companyId: string;
      customerCode: string;
      nameTh: string;
      nameEn: string | null;
      taxId: string | null;
      kycVerified: boolean;
      kycRiskLevel: KycRiskLevel | null;
      kycExpiresOn: Date | null;
    } | null;

    if (!customer) {
      this.logger.warn(
        `KYC request ${payload.request_id} references missing customer ${request.refId}`,
      );
      return;
    }

    // Idempotent: this request was already turned into a record.
    const already = await this.records.findFirst({
      where: { requestId: request.id },
      select: { id: true },
    });
    if (already) return;

    const [entries, config] = await Promise.all([
      this.watchlist.findMany({
        where: { companyId: customer.companyId, active: true },
        select: {
          id: true,
          name: true,
          normalizedName: true,
          taxId: true,
          reason: true,
        },
      }) as Promise<WatchlistEntry[]>,
      this.configs.findFirst({
        where: { companyId: customer.companyId },
        select: {
          kycReviewMonthsHigh: true,
          kycReviewMonthsMedium: true,
          kycReviewMonthsLow: true,
        },
      }) as Promise<{
        kycReviewMonthsHigh: number;
        kycReviewMonthsMedium: number;
        kycReviewMonthsLow: number;
      } | null>,
    ]);

    const matches = screenAgainst(customer, entries);
    const missingDocs = missingRequiredDocs(request);
    const suggested = suggestRisk({ matches, missingDocs });
    const answers = readReviewerAnswers(request.receiverFormData);
    const riskLevel = answers.riskLevel ?? suggested;
    const hit = matches.length > 0 && !answers.clearanceNote;

    const today = bangkokDay(now);
    const { reviewDueOn, expiresOn } = kycDates(
      today,
      riskLevel,
      {
        high: config?.kycReviewMonthsHigh ?? 12,
        medium: config?.kycReviewMonthsMedium ?? 24,
        low: config?.kycReviewMonthsLow ?? 36,
      },
      answers.documentsExpireOn,
    );

    const record = (await this.records.create({
      data: {
        companyId: customer.companyId,
        customerId: customer.id,
        requestId: request.id,
        status: hit ? 'screening_hit' : 'verified',
        riskLevel,
        suggestedRisk: suggested,
        screening: {
          checkedAt: now.toISOString(),
          matches,
          missingDocs,
        } as unknown as Prisma.InputJsonValue,
        clearanceNote: answers.clearanceNote,
        documentsExpireOn: answers.documentsExpireOn
          ? new Date(`${answers.documentsExpireOn}T00:00:00Z`)
          : null,
        signatories: answers.signatories,
        reviewDueOn: new Date(`${reviewDueOn}T00:00:00Z`),
        expiresOn: new Date(`${expiresOn}T00:00:00Z`),
        recordedBy: request.assigneeUserId ?? request.receiverUserId,
      },
    })) as { id: string };

    const label = request.requestNo ?? request.id;

    if (hit) {
      await this.audit.record({
        eventType: 'crm.customer.kyc_screening_hit',
        companyId: customer.companyId,
        actorId: null,
        actorUsername: 'kyc-callback',
        resourceType: 'customer',
        resourceId: customer.id,
        after: {
          requestId: request.id,
          recordId: record.id,
          matches: matches as unknown as Prisma.InputJsonValue,
        },
      });
      await this.timeline.publish({
        companyId: customer.companyId,
        customerId: customer.id,
        refType: 'request',
        refId: request.id,
        eventType: 'customer.kyc_screening_hit',
        summary: `KYC ไม่ผ่าน — ชื่อตรงกับรายชื่อต้องห้าม ${matches.length} รายการ และไม่มีเหตุผลการยกเว้น · คำขอ ${label}`,
        actorId: null,
        actorName: 'ระบบ (คำขอ KYC)',
      });
      return;
    }

    // The previous verification, if any, is replaced by this one.
    await this.records.updateMany({
      where: {
        customerId: customer.id,
        status: 'verified',
        id: { not: record.id },
      },
      data: { status: 'superseded' },
    });

    const expiresOnDate = new Date(`${expiresOn}T00:00:00Z`);
    await this.customers.update({
      where: { id: customer.id },
      data: {
        kycVerified: true,
        kycVerifiedAt: now,
        kycRiskLevel: riskLevel,
        kycExpiresOn: expiresOnDate,
      },
    });

    await this.fieldChanges.createMany([
      ...(customer.kycVerified
        ? []
        : [
            {
              customerId: customer.id,
              field: 'kycVerified',
              before: false,
              after: true,
              changedBy: null,
            },
          ]),
      {
        customerId: customer.id,
        field: 'kycRiskLevel',
        before: customer.kycRiskLevel ?? undefined,
        after: riskLevel,
        changedBy: null,
      },
      {
        customerId: customer.id,
        field: 'kycExpiresOn',
        before: customer.kycExpiresOn?.toISOString().slice(0, 10) ?? undefined,
        after: expiresOn,
        changedBy: null,
      },
    ]);

    await this.audit.record({
      eventType: 'crm.customer.kyc_verified',
      companyId: customer.companyId,
      actorId: null,
      actorUsername: 'kyc-callback',
      resourceType: 'customer',
      resourceId: customer.id,
      after: {
        requestId: request.id,
        requestNo: request.requestNo,
        recordId: record.id,
        riskLevel,
        suggestedRisk: suggested,
        expiresOn,
        clearedMatches: matches.length,
      },
    });

    await this.timeline.publish({
      companyId: customer.companyId,
      customerId: customer.id,
      refType: 'request',
      refId: request.id,
      eventType: 'customer.kyc_verified',
      summary:
        `ยืนยันตัวตน (KYC) สำเร็จ · ความเสี่ยง${RISK_TH[riskLevel]} · ใช้ได้ถึง ${expiresOn} · คำขอ ${label}` +
        (matches.length ? ' (ยกเว้นรายชื่อต้องห้ามตามเหตุผลของผู้ตรวจ)' : ''),
      actorId: null,
      actorName: 'ระบบ (คำขอ KYC)',
    });
  }
}

/** Required document codes of the KYC type with no live attachment. */
function missingRequiredDocs(request: CompletedKyc): string[] {
  const required = Array.isArray(request.requestType?.requiredDocs)
    ? (
        request.requestType.requiredDocs as {
          code?: unknown;
          required?: unknown;
        }[]
      )
        .filter((doc) => doc.required !== false && typeof doc.code === 'string')
        .map((doc) => doc.code as string)
    : [];
  const attached = new Set(
    request.attachments
      .filter((file) => !file.deletedAt && file.docCode)
      .map((file) => file.docCode as string),
  );
  return required.filter((code) => !attached.has(code));
}
