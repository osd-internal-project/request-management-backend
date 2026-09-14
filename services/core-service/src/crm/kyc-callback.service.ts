import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AuditWriter } from '@request-management/share';
import { DomainEventsService } from '../events/domain-events.service';
import { DOMAIN_EVENTS } from '../events/event-catalog';
import { RequestRepository } from '../requests/request.repository';
import { CustomerRepository } from './customer.repository';
import { CustomerFieldChangeRepository } from './customer-child.repositories';
import { CustomerTimelineService } from './customer-timeline.service';

/**
 * CM-04 (ชุดงาน B) — the KYC callback the schema comment promised:
 * `kycVerified` is "set by the KYC request callback, never directly by a
 * screen". This is that callback: when a request of type `KYC` that
 * references a customer completes, the flag flips here — with its field
 * history, audit entry and timeline event — and nowhere else.
 *
 * Subscribed to the in-process domain events (§11.8); idempotent, so the
 * event firing twice cannot double-write history.
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
  ) {}

  onModuleInit(): void {
    this.events.on(DOMAIN_EVENTS.requestCompleted, (event) =>
      this.onRequestCompleted(
        event.payload as { request_id: string; type_code: string },
      ),
    );
  }

  async onRequestCompleted(payload: {
    request_id: string;
    type_code: string;
  }): Promise<void> {
    if (payload.type_code !== 'KYC') return;

    const request = (await this.requests.findFirst({
      where: { id: payload.request_id },
      select: { id: true, requestNo: true, refType: true, refId: true },
    })) as {
      id: string;
      requestNo: string | null;
      refType: string | null;
      refId: string | null;
    } | null;

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
        kycVerified: true,
      },
    })) as {
      id: string;
      companyId: string;
      customerCode: string;
      kycVerified: boolean;
    } | null;

    if (!customer) {
      this.logger.warn(
        `KYC request ${payload.request_id} references missing customer ${request.refId}`,
      );
      return;
    }

    // Idempotent: a re-emitted event finds the flag already set and stops.
    if (customer.kycVerified) return;

    await this.customers.update({
      where: { id: customer.id },
      data: { kycVerified: true, kycVerifiedAt: new Date() },
    });

    await this.fieldChanges.createMany([
      {
        customerId: customer.id,
        field: 'kycVerified',
        before: false,
        after: true,
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
      after: { requestId: request.id, requestNo: request.requestNo },
    });

    await this.timeline.publish({
      companyId: customer.companyId,
      customerId: customer.id,
      refType: 'request',
      refId: request.id,
      eventType: 'customer.kyc_verified',
      summary: `ยืนยันตัวตน (KYC) สำเร็จ · คำขอ ${request.requestNo ?? request.id}`,
      actorId: null,
      actorName: 'ระบบ (คำขอ KYC)',
    });
  }
}
