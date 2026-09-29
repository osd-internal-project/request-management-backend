import { CustomerContractRepository } from './contract.repositories';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { RequestRepository } from '../requests/request.repository';
import { DomainEventsService } from '../events/domain-events.service';
import {
  DOMAIN_EVENTS,
  type DomainEventName,
  type RequestEventPayload,
} from '../events/event-catalog';
import { CustomerTimelineService } from './customer-timeline.service';
import {
  OpportunityRepository,
  QuotationRepository,
} from './sales.repositories';

/** Which request moments are worth a line on the customer's history. */
const MOMENTS: readonly [DomainEventName, string][] = [
  [DOMAIN_EVENTS.requestSubmitted, 'ยื่นแล้ว'],
  [DOMAIN_EVENTS.requestApproved, 'อนุมัติ'],
  [DOMAIN_EVENTS.requestPreApproved, 'อนุมัติ (ก่อนเริ่มงาน)'],
  [DOMAIN_EVENTS.requestRejected, 'ไม่อนุมัติ'],
  [DOMAIN_EVENTS.requestCompleted, 'ปิดงาน'],
  [DOMAIN_EVENTS.requestCancelled, 'ยกเลิก'],
];

interface RequestRow {
  id: string;
  requestNo: string | null;
  companyId: string;
  typeCode: string;
  refType: string | null;
  refId: string | null;
  typeSnapshot: unknown;
}

/**
 * CD-69 / CD-66 — คำขอที่อ้างถึงลูกค้า (ตรง ๆ หรือผ่านโอกาสการขาย/ใบเสนอราคาของ
 * ลูกค้านั้น) ขึ้นในไทม์ไลน์ลูกค้า: ยื่น · อนุมัติ/ไม่อนุมัติ · ปิดงาน · ยกเลิก.
 *
 * ก่อนหน้านี้มีแค่ผล KYC ที่ไหลเข้าไทม์ไลน์ — คำขออื่นที่ยื่นจากปุ่ม "ยื่นคำขอ"
 * บนหน้า 360° ไม่เคยปรากฏ ซึ่งขัด AC "ไทม์ไลน์ของทุกเหตุการณ์สำคัญข้ามโมดูล".
 *
 * เขียนด้วย `refType: 'request'` — ไทม์ไลน์กรองแถวชนิดนี้ด้วย
 * `visibleRequestsWhere` อยู่แล้ว (C360-03) คนที่เปิดคำขอนั้นไม่ได้จึงไม่เห็นบรรทัดนี้.
 * Idempotent: event ส่งซ้ำได้ (§11.8) บรรทัดเดิมจึงถูกเช็คก่อนเขียน.
 */
@Injectable()
export class RequestTimelineSyncService implements OnModuleInit {
  private readonly logger = new Logger(RequestTimelineSyncService.name);

  constructor(
    private readonly events: DomainEventsService,
    private readonly requests: RequestRepository,
    private readonly opportunities: OpportunityRepository,
    private readonly quotations: QuotationRepository,
    private readonly timeline: CustomerTimelineService,
    private readonly contracts: CustomerContractRepository,
  ) {}

  onModuleInit(): void {
    for (const [name, label] of MOMENTS) {
      this.events.on(name, (event) =>
        this.onRequestEvent(
          name,
          label,
          event.payload as RequestEventPayload,
        ).catch((error: Error) =>
          this.logger.warn(
            `timeline for request ${(event.payload as RequestEventPayload).request_id}: ${error.message}`,
          ),
        ),
      );
    }
  }

  async onRequestEvent(
    name: DomainEventName,
    label: string,
    payload: RequestEventPayload,
  ): Promise<void> {
    const request = (await this.requests.findFirst({
      where: { id: payload.request_id },
      select: {
        id: true,
        requestNo: true,
        companyId: true,
        typeCode: true,
        refType: true,
        refId: true,
        typeSnapshot: true,
      },
    })) as RequestRow | null;
    if (!request?.refType || !request.refId) return;

    const customerId = await this.customerOf(request);
    if (!customerId) return;

    const line = {
      customerId,
      refType: 'request',
      refId: request.id,
      eventType: name,
    };
    if (await this.timeline.has(line)) return;

    await this.timeline.publish({
      ...line,
      companyId: request.companyId,
      summary: `คำขอ ${request.requestNo ?? '(ร่าง)'} · ${typeName(request)} — ${label}`,
      actorId: null,
      actorName: 'ระบบคำขอ',
    });
  }

  /**
   * The customer a request is about. Refs are what each screen sends:
   * `customer` by id, `opportunity` by its OPP code, `quotation` by id,
   * `contract` by its number (CD-67) — a
   * prospect with no customer yet has no timeline to write to.
   */
  private async customerOf(request: RequestRow): Promise<string | null> {
    const ref = request.refId as string;
    switch (request.refType) {
      case 'customer':
        return ref;
      case 'opportunity': {
        const found = (await this.opportunities.findFirst({
          where: {
            companyId: request.companyId,
            OR: [{ opportunityCode: ref }, { id: ref }],
          },
          select: { customerId: true },
        })) as { customerId: string | null } | null;
        return found?.customerId ?? null;
      }
      case 'quotation': {
        const found = (await this.quotations.findFirst({
          where: { id: ref, companyId: request.companyId },
          select: {
            customerId: true,
            opportunity: { select: { customerId: true } },
          },
        })) as {
          customerId: string | null;
          opportunity: { customerId: string | null };
        } | null;
        return found?.customerId ?? found?.opportunity.customerId ?? null;
      }
      case 'contract': {
        // CD-67 — a case raised against a contract, by its number or id
        const found = (await this.contracts.findFirst({
          where: {
            companyId: request.companyId,
            OR: [{ contractNo: ref }, { id: ref }],
          },
          select: { customerId: true },
        })) as { customerId: string } | null;
        return found?.customerId ?? null;
      }
      default:
        return null;
    }
  }
}

function typeName(request: RequestRow): string {
  const snapshot = request.typeSnapshot as { name?: unknown } | null;
  return typeof snapshot?.name === 'string' ? snapshot.name : request.typeCode;
}
