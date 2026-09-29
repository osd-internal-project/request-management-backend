import { Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import {
  AppError,
  AuditWriter,
  auditActor,
  resolveTargetCompany,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import { CompanyMemberRepository } from '../access/company-member.repository';
import { RequestsService } from '../requests/requests.service';
import { CustomerRepository } from './customer.repository';
import { CustomerContactRepository } from './customer-child.repositories';
import { RequestIntakeChannelRepository } from './customer-intake.repository';
import {
  INTAKE_CHANNELS,
  IntakeSubmissionDto,
  SaveIntakeChannelDto,
  type IntakeChannelCode,
} from './dto/customer-intake.dto';

interface ChannelRow {
  id: string;
  companyId: string;
  channel: IntakeChannelCode;
  enabled: boolean;
  requesterUserId: string;
  typeCodes: string[];
  slug: string | null;
  title: string | null;
  intro: string | null;
  updatedAt: Date;
}

const digits = (value: string | null | undefined) =>
  (value ?? '').replace(/\D/g, '');

/**
 * CD-66 — คำขอจากลูกค้า (user decisions 29 ก.ย. 2569): customers raise
 * requests themselves through a company's intake channels — the public web
 * form first, LINE and AI CARE as connectors over the same path.
 *
 * - Every channel names a staff user who stands as the requester (a request
 *   must have one); the customer is kept as the contact on the request, and
 *   linked to their customer record when the tax id or a contact email
 *   matches one in that company.
 * - A channel offers only the request types its admin listed.
 * - The customer gets the request number and a private status link; the
 *   token behind it is stored only as a hash (RequestsService).
 *
 * Reached from external-service with an API key holding
 * `integration.request.intake` — never from the screens' BFF — so no route
 * here is unauthenticated. The public page lives on the frontend and calls
 * with its server-side key (docs/customer-intake.md).
 */
@Injectable()
export class CustomerIntakeService {
  constructor(
    private readonly channels: RequestIntakeChannelRepository,
    private readonly customers: CustomerRepository,
    private readonly contacts: CustomerContactRepository,
    private readonly members: CompanyMemberRepository,
    private readonly requests: RequestsService,
    private readonly audit: AuditWriter,
  ) {}

  // --- the channels (external-service) -----------------------------------

  /** The public form behind a web-form link: its wording and request types. */
  async webForm(slug: string, keyCompanyId: string | null) {
    const channel = await this.openWebForm(slug, keyCompanyId);
    return {
      company_name: channel.company.name,
      title: channel.title,
      intro: channel.intro,
      types: await this.requests.channelTypes(
        channel.companyId,
        channel.typeCodes,
      ),
    };
  }

  async submitWebForm(
    slug: string,
    dto: IntakeSubmissionDto,
    actor: Principal,
    keyCompanyId: string | null,
    authorization: string,
  ) {
    const channel = await this.openWebForm(slug, keyCompanyId);
    return this.submitThrough(channel, dto, actor, authorization);
  }

  /**
   * A connector (AI CARE, the LINE webhook) submitting for the company its
   * key or its route names.
   */
  async submitChannel(
    channelCode: IntakeChannelCode,
    companyId: string,
    dto: IntakeSubmissionDto,
    actor: Principal,
    authorization: string,
  ) {
    const channel = (await this.channels.findFirst({
      where: { companyId, channel: channelCode, enabled: true },
    })) as ChannelRow | null;
    if (!channel) {
      throw new AppError('NOT_FOUND', 'ช่องทางนี้ยังไม่เปิดรับคำขอ', [
        { field: 'channel', reason: channelCode },
      ]);
    }
    return this.submitThrough(channel, dto, actor, authorization);
  }

  /** The private status link. An unknown token is 404, never a hint. */
  status(token: string) {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) {
      throw new AppError('NOT_FOUND', 'ไม่พบคำขอ');
    }
    return this.requests.statusByToken(token);
  }

  /**
   * The company a connector route names by its code — only one that has set
   * up that channel; anything else is "not found", like an unknown code.
   */
  async companyIdOfCode(
    code: string,
    channelCode: IntakeChannelCode,
  ): Promise<string | null> {
    const channel = (await this.channels.findFirst({
      where: { company: { code }, channel: channelCode },
      select: { companyId: true },
    })) as { companyId: string } | null;
    return channel?.companyId ?? null;
  }

  private async openWebForm(
    slug: string,
    keyCompanyId: string | null,
  ): Promise<ChannelRow & { company: { name: string } }> {
    const channel = (await this.channels.findFirst({
      where: { slug, channel: 'web_form', enabled: true },
      include: { company: { select: { name: true } } },
    })) as (ChannelRow & { company: { name: string } }) | null;
    // A key bound to one company never reaches another company's form.
    if (!channel || (keyCompanyId && channel.companyId !== keyCompanyId)) {
      throw new AppError('NOT_FOUND', 'ไม่พบแบบฟอร์มนี้ หรือปิดรับแล้ว');
    }
    return channel;
  }

  private async submitThrough(
    channel: ChannelRow,
    dto: IntakeSubmissionDto,
    actor: Principal,
    authorization: string,
  ) {
    if (!channel.typeCodes.includes(dto.type_code)) {
      throw new AppError(
        'VALIDATION_FAILED',
        'ช่องทางนี้ไม่ได้เปิดรับคำขอประเภทนี้',
        [{ field: 'type_code', reason: dto.type_code }],
      );
    }
    if (
      !dto.contact.email?.trim() &&
      !dto.contact.phone?.trim() &&
      !dto.contact.line_user_id
    ) {
      throw new AppError(
        'VALIDATION_FAILED',
        'ต้องมีอีเมลหรือเบอร์โทรอย่างน้อยหนึ่งช่องทางสำหรับติดต่อกลับ',
        [{ field: 'contact', reason: 'email_or_phone' }],
      );
    }

    const customerId = await this.matchCustomer(channel.companyId, dto);
    const { detail, statusToken } = await this.requests.createFromChannel(
      {
        companyId: channel.companyId,
        channel: channel.channel,
        typeCode: dto.type_code,
        requesterUserId: channel.requesterUserId,
        formData: dto.form_data ?? {},
        contact: {
          name: dto.contact.name.trim(),
          email: dto.contact.email?.trim().toLowerCase() || null,
          phone: dto.contact.phone?.trim() || null,
          company: dto.contact.company?.trim() || null,
          taxId: digits(dto.contact.tax_id) || null,
          lineUserId: dto.contact.line_user_id ?? null,
        },
        ref: customerId ? { type: 'customer', id: customerId } : null,
      },
      actor,
      authorization,
    );
    return {
      request_no: detail.requestNo,
      status: detail.status,
      status_token: statusToken,
      customer_matched: Boolean(customerId),
    };
  }

  /**
   * The customer this submission is from, if the company knows them: the
   * same tax id (head office first), else an active contact with the same
   * email. A merged-away record never matches.
   */
  private async matchCustomer(
    companyId: string,
    dto: IntakeSubmissionDto,
  ): Promise<string | null> {
    const taxId = digits(dto.contact.tax_id);
    if (taxId.length === 13) {
      const byTax = (await this.customers.findFirst({
        where: { companyId, taxId, mergedIntoCustomerId: null },
        orderBy: { branchCode: 'asc' },
        select: { id: true },
      })) as { id: string } | null;
      if (byTax) return byTax.id;
    }
    const email = dto.contact.email?.trim();
    if (email) {
      const byEmail = (await this.contacts.findFirst({
        where: {
          email: { equals: email, mode: 'insensitive' },
          active: true,
          customer: { companyId, mergedIntoCustomerId: null },
        },
        select: { customerId: true },
      })) as { customerId: string } | null;
      if (byEmail) return byEmail.customerId;
    }
    return null;
  }

  // --- the admin screen (core-service) -----------------------------------

  async listAdmin(actor: Principal, requestedCompanyId?: string) {
    const companyId = resolveTargetCompany(actor, requestedCompanyId);
    const rows = (await this.channels.findMany({
      where: { companyId },
      include: { requester: { select: { id: true, displayName: true } } },
    })) as unknown as (ChannelRow & {
      requester: { id: string; displayName: string };
    })[];
    return INTAKE_CHANNELS.map((code) => {
      const row = rows.find((r) => r.channel === code);
      return {
        channel: code,
        configured: Boolean(row),
        enabled: row?.enabled ?? false,
        requester: row?.requester ?? null,
        type_codes: row?.typeCodes ?? [],
        slug: row?.slug ?? null,
        title: row?.title ?? null,
        intro: row?.intro ?? null,
        updated_at: row?.updatedAt ?? null,
      };
    });
  }

  async save(
    channelCode: IntakeChannelCode,
    dto: SaveIntakeChannelDto,
    actor: Principal,
  ) {
    const companyId = resolveTargetCompany(actor, dto.company_id);
    const member = await this.members.findFirst({
      where: {
        id: dto.requester_user_id,
        status: 'ACTIVE',
        companies: { some: { companyId } },
      },
      select: { id: true },
    });
    if (!member) {
      throw new AppError(
        'VALIDATION_FAILED',
        'ผู้ยื่นแทนต้องเป็นผู้ใช้ที่ยังทำงานอยู่ในบริษัทนี้',
        [{ field: 'requester_user_id', reason: dto.requester_user_id }],
      );
    }
    const codes = [...new Set(dto.type_codes)];
    const offered = await this.requests.channelTypes(companyId, codes);
    const missing = codes.filter(
      (code) => !offered.some((type) => type.code === code),
    );
    if (missing.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        `ประเภทคำขอที่ไม่มีหรือไม่ได้เปิดในบริษัทนี้: ${missing.join(', ')}`,
        missing.map((code) => ({ field: 'type_codes', reason: code })),
      );
    }

    const before = (await this.channels.findFirst({
      where: { companyId, channel: channelCode },
    })) as ChannelRow | null;
    const slug =
      channelCode !== 'web_form'
        ? null
        : !before?.slug || dto.new_link
          ? randomBytes(9).toString('base64url')
          : before.slug;

    const data = {
      enabled: dto.enabled,
      requesterUserId: dto.requester_user_id,
      typeCodes: codes,
      slug,
      title: dto.title?.trim() || null,
      intro: dto.intro?.trim() || null,
      updatedBy: actor.userId,
    };
    await this.channels.upsert({
      where: { companyId_channel: { companyId, channel: channelCode } },
      create: {
        companyId,
        channel: channelCode,
        ...data,
        createdBy: actor.userId,
      },
      update: data,
    });
    await this.audit.record({
      eventType: 'request.intake_channel.saved',
      companyId,
      ...auditActor(actor),
      resourceType: 'request_intake_channel',
      resourceId: channelCode,
      before: before
        ? {
            enabled: before.enabled,
            requesterUserId: before.requesterUserId,
            typeCodes: before.typeCodes,
            slugChanged: false,
          }
        : { configured: false },
      after: {
        enabled: dto.enabled,
        requesterUserId: dto.requester_user_id,
        typeCodes: codes,
        slugChanged: Boolean(before?.slug && slug !== before.slug),
      },
    });
    return (await this.listAdmin(actor, companyId)).find(
      (row) => row.channel === channelCode,
    );
  }
}
