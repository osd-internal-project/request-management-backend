import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PDFDocument } from 'pdf-lib';
import {
  AppError,
  AuditWriter,
  auditActor,
  OBJECT_STORAGE,
  Principal,
  PrismaTransactionService,
} from '@request-management/share';
import type { ObjectStorage } from '@request-management/share';
import { CompanyMemberRepository } from '../access/company-member.repository';
import { DomainEventsService } from '../events/domain-events.service';
import { DOMAIN_EVENTS } from '../events/event-catalog';
import { NotificationsService } from '../notifications/notifications.service';
import {
  allSigned,
  hashOtp,
  hashToken,
  newOtp,
  newToken,
  newVerifyCode,
  OTP_MAX_ATTEMPTS,
  OTP_RESEND_MS,
  OTP_SESSION_MS,
  OTP_TTL_MS,
  readSignatureImage,
  sha256,
  turnOf,
  type LayoutField,
} from './esign-rules';
import { seal, type SealSigner } from './esign-seal';
import { ESIGN_SENDER, type EsignSender } from './esign-sender';
import { EsignLayoutsService, readFields } from './esign-layouts.service';
import { EsignAuthoritiesService } from './esign-authorities.service';
import {
  EsignEnvelopeRepository,
  EsignEventRepository,
  EsignSignerRepository,
} from './esign.repositories';
import type { EnvelopeSignerDto, SignDto } from './esign.dto';

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

export interface CreateEnvelopeInput {
  companyId: string;
  title: string;
  pdf: Buffer;
  originalName: string;
  sourceType: string;
  sourceId: string;
  refType: string;
  refId: string;
  layoutId: string;
  /** CD-172 — what the authority check compares a signer's limit with. */
  amount?: number | null;
  mode?: 'sequential' | 'parallel';
  expiresInDays?: number;
  message?: string;
  signers: EnvelopeSignerDto[];
}

interface EnvelopeRow {
  id: string;
  companyId: string;
  title: string;
  fields: unknown;
  mode: string;
  status: string;
  message: string | null;
  sourceType: string;
  sourceId: string;
  refType: string;
  refId: string;
  originalKey: string;
  originalName: string;
  originalHash: string;
  signedKey: string | null;
  signedHash: string | null;
  verifyCode: string;
  docType: string;
  amount: { toString(): string } | null;
  expiresAt: Date;
  createdBy: string;
  createdAt: Date;
  sentAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
}

interface SignerRow {
  id: string;
  envelopeId: string;
  fieldKey: string;
  order: number;
  kind: string;
  userId: string | null;
  name: string;
  email: string | null;
  phone: string | null;
  status: string;
  tokenExpiresAt: Date | null;
  otpHash: string | null;
  otpChannel: string | null;
  otpSentAt: Date | null;
  otpExpiresAt: Date | null;
  otpAttempts: number;
  otpVerifiedAt: Date | null;
  viewedAt: Date | null;
  signedAt: Date | null;
  signatureKind: string | null;
  signatureKey: string | null;
  signatureText: string | null;
  authMethod: string | null;
  ip: string | null;
  userAgent: string | null;
  declinedAt: Date | null;
  declinedReason: string | null;
}

const DAY_MS = 86_400_000;

/** `someone@example.com` → `so•••@example.com`; `0812345678` → `08•••••678`. */
export function mask(value: string | null): string | null {
  if (!value) return null;
  const at = value.indexOf('@');
  if (at > 0) return `${value.slice(0, 2)}•••${value.slice(at)}`;
  return `${value.slice(0, 2)}•••••${value.slice(-3)}`;
}

async function toBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array),
    );
  }
  return Buffer.concat(chunks);
}

/**
 * CD-14 ระบบลงนามอิเล็กทรอนิกส์ — the central signing service. A module
 * (Legal now, Delivery later) hands it a PDF, a layout and the signers;
 * this service keeps the PDF fixed (its hash), reaches each signer — an
 * internal one through the in-app inbox, an external one through a
 * single-use link and a one-time code — records every step, and once
 * everyone has signed seals a copy with the signatures and the evidence,
 * announcing `esign.completed` for the owning module to keep it.
 *
 * Public routes (the link, the code, the verification page) carry no login:
 * the link's secret is the credential, and only its hash is stored.
 */
@Injectable()
export class EsignService {
  private readonly logger = new Logger(EsignService.name);

  constructor(
    private readonly envelopes: EsignEnvelopeRepository,
    private readonly signers: EsignSignerRepository,
    private readonly events: EsignEventRepository,
    private readonly layouts: EsignLayoutsService,
    private readonly members: CompanyMemberRepository,
    private readonly notifications: NotificationsService,
    private readonly domainEvents: DomainEventsService,
    private readonly transactions: PrismaTransactionService,
    private readonly audit: AuditWriter,
    private readonly config: ConfigService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(ESIGN_SENDER) private readonly sender: EsignSender,
    private readonly authorities: EsignAuthoritiesService,
  ) {}

  // --- sending ----------------------------------------------------------------

  /** CD-166 — a draft envelope: the PDF fixed, the signers named. */
  async create(input: CreateEnvelopeInput, actor: Principal) {
    const layout = await this.layouts.usable(input.layoutId, input.companyId);
    try {
      await PDFDocument.load(input.pdf);
    } catch {
      throw new AppError(
        'VALIDATION_FAILED',
        'เปิดไฟล์ PDF ไม่ได้ (อาจเข้ารหัสไว้) — ส่งลงนามไม่ได้',
        [{ field: 'document', reason: 'unreadable_pdf' }],
      );
    }
    const people = await this.resolveSigners(
      layout.fields,
      input.signers,
      input.companyId,
      { docType: layout.docType, amount: input.amount ?? null },
    );
    const id = randomUUID();
    const originalKey = `esign/${id}/original.pdf`;
    const originalHash = sha256(input.pdf);
    await this.storage.put(originalKey, input.pdf, {
      contentType: 'application/pdf',
      size: input.pdf.length,
    });
    await this.transactions.execute(async (tx) => {
      await tx.esignEnvelope.create({
        data: {
          id,
          companyId: input.companyId,
          title: input.title,
          layoutId: layout.id,
          fields: layout.fields as unknown as Prisma.InputJsonValue,
          docType: layout.docType,
          amount: input.amount ?? null,
          mode: input.mode ?? 'sequential',
          message: input.message?.trim() || null,
          sourceType: input.sourceType,
          sourceId: input.sourceId,
          refType: input.refType,
          refId: input.refId,
          originalKey,
          originalName: input.originalName,
          originalHash,
          verifyCode: newVerifyCode(),
          expiresAt: new Date(
            Date.now() + (input.expiresInDays ?? 14) * DAY_MS,
          ),
          createdBy: actor.userId,
        },
      });
      await tx.esignSigner.createMany({
        data: people.map((person) => ({ envelopeId: id, ...person })),
      });
    });
    await this.audit.record({
      eventType: 'esign.envelope.created',
      companyId: input.companyId,
      ...auditActor(actor),
      resourceType: input.refType,
      resourceId: input.refId,
      after: {
        envelopeId: id,
        layout: layout.code,
        originalHash,
        signers: people.length,
      },
    });
    return this.view(id, actor);
  }

  /**
   * Send it: every external signer gets a single-use link (shown once in
   * the answer — no email yet), internal signers whose turn it is are told
   * in the app.
   */
  async send(id: string, actor: Principal, meta: RequestMeta) {
    const envelope = await this.require(id, actor);
    if (envelope.status !== 'draft') {
      throw new AppError('CONFLICT', 'ส่งลงนามไปแล้ว');
    }
    const people = await this.signersOf(id);
    const links: { signerId: string; name: string; link: string }[] = [];
    await this.transactions.execute(async (tx) => {
      const claimed = await tx.esignEnvelope.updateMany({
        where: { id, status: 'draft' },
        data: { status: 'sent', sentAt: new Date() },
      });
      if (claimed.count !== 1) throw new AppError('CONFLICT', 'ส่งลงนามไปแล้ว');
      for (const signer of people) {
        if (signer.kind === 'external') {
          const { token, hash } = newToken();
          await tx.esignSigner.update({
            where: { id: signer.id },
            data: { tokenHash: hash, tokenExpiresAt: envelope.expiresAt },
          });
          links.push({
            signerId: signer.id,
            name: signer.name,
            link: `${this.publicUrl()}/s/${token}`,
          });
        }
        await tx.esignEvent.create({
          data: {
            envelopeId: id,
            signerId: signer.id,
            type: 'sent',
            ip: meta.ip,
            userAgent: meta.userAgent,
          },
        });
      }
    });
    for (const link of links) {
      const signer = people.find((one) => one.id === link.signerId)!;
      await this.sender
        .sendLink(signer, {
          title: envelope.title,
          link: link.link,
          expiresAt: envelope.expiresAt,
          note: envelope.message,
        })
        .catch((error: Error) =>
          this.logger.warn(`signing link to ${signer.id}: ${error.message}`),
        );
    }
    await this.notifyTurn({ ...envelope, status: 'sent' }, people);
    await this.audit.record({
      eventType: 'esign.envelope.sent',
      companyId: envelope.companyId,
      ...auditActor(actor),
      resourceType: envelope.refType,
      resourceId: envelope.refId,
      after: { envelopeId: id, external: links.length },
    });
    const view = await this.view(id, actor);
    return Object.assign(view, { links });
  }

  async cancel(id: string, reason: string, actor: Principal) {
    const envelope = await this.require(id, actor);
    const done = await this.envelopes.updateMany({
      where: { id, status: { in: ['draft', 'sent'] } },
      data: {
        status: 'cancelled',
        cancelledAt: new Date(),
        cancelReason: reason.trim(),
      },
    });
    if (done.count !== 1) {
      throw new AppError('CONFLICT', 'เอกสารนี้ยกเลิกไม่ได้แล้ว');
    }
    await this.audit.record({
      eventType: 'esign.envelope.cancelled',
      companyId: envelope.companyId,
      ...auditActor(actor),
      resourceType: envelope.refType,
      resourceId: envelope.refId,
      after: { envelopeId: id, reason },
    });
    return this.view(id, actor);
  }

  /** For whoever sent it (and Legal): signers, their progress, the history. */
  async view(id: string, actor: Principal) {
    const envelope = await this.require(id, actor);
    const people = await this.signersOf(id);
    const history = (await this.events.findMany({
      where: { envelopeId: id },
      orderBy: { at: 'asc' },
    })) as {
      signerId: string | null;
      type: string;
      at: Date;
      ip: string | null;
    }[];
    const fields = readFields(envelope.fields);
    return {
      id: envelope.id,
      title: envelope.title,
      status: this.effectiveStatus(envelope),
      mode: envelope.mode,
      message: envelope.message,
      refType: envelope.refType,
      refId: envelope.refId,
      originalName: envelope.originalName,
      originalHash: envelope.originalHash,
      signedHash: envelope.signedHash,
      verifyCode: envelope.status === 'completed' ? envelope.verifyCode : null,
      expiresAt: envelope.expiresAt,
      createdAt: envelope.createdAt,
      sentAt: envelope.sentAt,
      completedAt: envelope.completedAt,
      cancelReason: envelope.cancelReason,
      signers: people.map((signer) => ({
        id: signer.id,
        fieldKey: signer.fieldKey,
        label:
          fields.find((field) => field.key === signer.fieldKey)?.label ??
          signer.fieldKey,
        order: signer.order,
        kind: signer.kind,
        name: signer.name,
        contact: mask(signer.email ?? signer.phone),
        status: signer.status,
        viewedAt: signer.viewedAt,
        signedAt: signer.signedAt,
        declinedReason: signer.declinedReason,
      })),
      history: history.map((event) => ({
        ...event,
        who: people.find((one) => one.id === event.signerId)?.name ?? null,
      })),
    };
  }

  async listFor(refType: string, refId: string, actor: Principal) {
    const rows = (await this.envelopes.findMany({
      where: { companyId: actor.activeCompanyId, refType, refId },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    })) as { id: string }[];
    return Promise.all(rows.map((row) => this.view(row.id, actor)));
  }

  /** The sealed PDF, for whoever may see the envelope. */
  async signedFile(id: string, actor: Principal) {
    const envelope = await this.require(id, actor);
    if (!envelope.signedKey) {
      throw new AppError('CONFLICT', 'เอกสารยังลงนามไม่ครบ');
    }
    return {
      fileName: envelope.originalName.replace(/\.pdf$/i, '') + '-signed.pdf',
      stream: await this.storage.get(envelope.signedKey),
    };
  }

  /** The sealed PDF's bytes, for the owning module to keep a copy. */
  async signedBytes(id: string): Promise<Buffer> {
    const envelope = (await this.envelopes.findFirst({
      where: { id },
    })) as EnvelopeRow | null;
    if (!envelope?.signedKey) throw new AppError('NOT_FOUND', 'ไม่พบเอกสาร');
    return toBuffer(await this.storage.get(envelope.signedKey));
  }

  // --- internal signers ---------------------------------------------------------

  /** What waits for me to sign. */
  async mine(actor: Principal) {
    const rows = (await this.signers.findMany({
      where: {
        userId: actor.userId,
        status: 'pending',
        envelope: {
          companyId: actor.activeCompanyId,
          status: 'sent',
          expiresAt: { gt: new Date() },
        },
      },
      include: { envelope: true },
      orderBy: { envelope: { sentAt: 'asc' } },
    })) as unknown as (SignerRow & { envelope: EnvelopeRow })[];
    const out: {
      signerId: string;
      title: string;
      role: string;
      expiresAt: Date;
      turn: { may: boolean; waitingFor: number };
    }[] = [];
    for (const row of rows) {
      const all = await this.signersOf(row.envelopeId);
      out.push({
        signerId: row.id,
        title: row.envelope.title,
        role: this.roleOf(row.envelope, row),
        expiresAt: row.envelope.expiresAt,
        turn: turnOf(row, all, row.envelope.mode),
      });
    }
    return out;
  }

  async internalView(signerId: string, actor: Principal) {
    const { signer, envelope } = await this.internal(signerId, actor);
    return this.signerView(signer, envelope);
  }

  async internalDocument(
    signerId: string,
    actor: Principal,
    meta: RequestMeta,
  ) {
    const { signer, envelope } = await this.internal(signerId, actor);
    await this.assertAuthority(signer, envelope);
    return this.document(signer, envelope, meta);
  }

  async internalSign(
    signerId: string,
    dto: SignDto,
    actor: Principal,
    meta: RequestMeta,
  ) {
    const { signer, envelope } = await this.internal(signerId, actor);
    await this.assertAuthority(signer, envelope);
    await this.sign(signer, envelope, dto, 'keycloak', meta);
    return this.signerView(
      await this.signerById(signer.id),
      await this.envelopeById(envelope.id),
    );
  }

  async internalDecline(
    signerId: string,
    reason: string,
    actor: Principal,
    meta: RequestMeta,
  ) {
    const { signer, envelope } = await this.internal(signerId, actor);
    await this.decline(signer, envelope, reason, meta);
    return this.signerView(
      await this.signerById(signer.id),
      await this.envelopeById(envelope.id),
    );
  }

  // --- external signers (public) --------------------------------------------------

  async publicView(token: string, meta: RequestMeta) {
    const { signer, envelope } = await this.byToken(token);
    await this.record(envelope.id, signer.id, 'opened', meta);
    return {
      ...(await this.signerView(signer, envelope)),
      channels: [
        ...(signer.email ? [{ channel: 'email', to: mask(signer.email) }] : []),
        ...(signer.phone ? [{ channel: 'sms', to: mask(signer.phone) }] : []),
      ],
      verified: this.verified(signer),
    };
  }

  /** CD-167 — send the one-time code. */
  async sendCode(
    token: string,
    channel: 'email' | 'sms' | undefined,
    meta: RequestMeta,
  ) {
    const { signer, envelope } = await this.byToken(token);
    this.assertPending(signer, envelope);
    const chosen = channel ?? (signer.email ? 'email' : 'sms');
    const address = chosen === 'email' ? signer.email : signer.phone;
    if (!address) {
      throw new AppError('VALIDATION_FAILED', 'ไม่มีช่องทางนี้สำหรับผู้ลงนาม');
    }
    if (
      signer.otpSentAt &&
      Date.now() - signer.otpSentAt.getTime() < OTP_RESEND_MS
    ) {
      throw new AppError('CONFLICT', 'ขอรหัสใหม่ได้เมื่อครบ 1 นาที');
    }
    const { code, hash } = newOtp(this.secret());
    const expiresAt = new Date(Date.now() + OTP_TTL_MS);
    await this.signers.update({
      where: { id: signer.id },
      data: {
        otpHash: hash,
        otpChannel: chosen,
        otpSentAt: new Date(),
        otpExpiresAt: expiresAt,
        otpAttempts: 0,
        otpVerifiedAt: null,
      },
    });
    await this.sender.sendCode(chosen, address, {
      title: envelope.title,
      code,
      expiresAt,
    });
    await this.record(envelope.id, signer.id, 'otp_sent', meta, {
      channel: chosen,
    });
    return { channel: chosen, to: mask(address), expiresAt };
  }

  async verifyCode(token: string, code: string, meta: RequestMeta) {
    const { signer, envelope } = await this.byToken(token);
    this.assertPending(signer, envelope);
    if (!signer.otpHash || !signer.otpExpiresAt) {
      throw new AppError('CONFLICT', 'ขอรหัสก่อน');
    }
    if (signer.otpExpiresAt.getTime() < Date.now()) {
      throw new AppError('CONFLICT', 'รหัสหมดอายุ — ขอรหัสใหม่');
    }
    if (signer.otpAttempts >= OTP_MAX_ATTEMPTS) {
      throw new AppError('CONFLICT', 'กรอกรหัสผิดเกินกำหนด — ขอรหัสใหม่');
    }
    if (hashOtp(code, this.secret()) !== signer.otpHash) {
      await this.signers.update({
        where: { id: signer.id },
        data: { otpAttempts: { increment: 1 } },
      });
      await this.record(envelope.id, signer.id, 'otp_failed', meta);
      throw new AppError('VALIDATION_FAILED', 'รหัสไม่ถูกต้อง', [
        { field: 'code', reason: 'mismatch' },
      ]);
    }
    await this.signers.update({
      where: { id: signer.id },
      data: { otpVerifiedAt: new Date(), otpHash: null },
    });
    await this.record(envelope.id, signer.id, 'otp_verified', meta, {
      channel: signer.otpChannel,
    });
    return { verified: true };
  }

  async publicDocument(token: string, meta: RequestMeta) {
    const { signer, envelope } = await this.byToken(token);
    this.assertVerified(signer);
    return this.document(signer, envelope, meta);
  }

  async publicSign(token: string, dto: SignDto, meta: RequestMeta) {
    const { signer, envelope } = await this.byToken(token);
    this.assertVerified(signer);
    await this.sign(
      signer,
      envelope,
      dto,
      signer.otpChannel === 'sms' ? 'otp_sms' : 'otp_email',
      meta,
    );
    return { signed: true };
  }

  async publicDecline(token: string, reason: string, meta: RequestMeta) {
    const { signer, envelope } = await this.byToken(token);
    this.assertVerified(signer);
    await this.decline(signer, envelope, reason, meta);
    return { declined: true };
  }

  // --- CD-173 verification page (public) ------------------------------------------

  async verifyInfo(code: string) {
    const envelope = (await this.envelopes.findFirst({
      where: { verifyCode: code.toUpperCase(), status: 'completed' },
    })) as EnvelopeRow | null;
    if (!envelope)
      throw new AppError('NOT_FOUND', 'ไม่พบเอกสารที่ลงนามด้วยรหัสนี้');
    const people = await this.signersOf(envelope.id);
    return {
      title: envelope.title,
      completedAt: envelope.completedAt,
      signedHash: envelope.signedHash,
      signers: people.map((signer) => ({
        role: this.roleOf(envelope, signer),
        name: signer.name,
        signedAt: signer.signedAt,
      })),
    };
  }

  /** Is the file the holder has the sealed one? Only its hash is sent. */
  async verifyHash(code: string, hash: string) {
    const info = await this.verifyInfo(code);
    return { match: info.signedHash === hash.toLowerCase() };
  }

  // --- the signing steps ------------------------------------------------------------

  private async document(
    signer: SignerRow,
    envelope: EnvelopeRow,
    meta: RequestMeta,
  ) {
    if (!signer.viewedAt && signer.status === 'pending') {
      await this.signers.update({
        where: { id: signer.id },
        data: { viewedAt: new Date() },
      });
      await this.record(envelope.id, signer.id, 'viewed', meta);
    }
    return {
      fileName: envelope.originalName,
      stream: await this.storage.get(envelope.originalKey),
    };
  }

  private async sign(
    signer: SignerRow,
    envelope: EnvelopeRow,
    dto: SignDto,
    authMethod: string,
    meta: RequestMeta,
  ) {
    this.assertPending(signer, envelope);
    const all = await this.signersOf(envelope.id);
    const turn = turnOf(signer, all, envelope.mode);
    if (!turn.may) {
      throw new AppError(
        'CONFLICT',
        `ยังไม่ถึงลำดับของคุณ — รออีก ${turn.waitingFor} ผู้ลงนาม`,
      );
    }
    if (!signer.viewedAt) {
      throw new AppError('CONFLICT', 'เปิดอ่านเอกสารฉบับเต็มก่อนลงนาม');
    }
    if (!dto.consent) {
      throw new AppError(
        'VALIDATION_FAILED',
        'ต้องยืนยันการลงนามอิเล็กทรอนิกส์',
        [{ field: 'consent', reason: 'required' }],
      );
    }
    let signatureKey: string | null = null;
    let signatureText: string | null = null;
    if (dto.kind === 'type') {
      signatureText = dto.text?.trim() || null;
      if (!signatureText) {
        throw new AppError(
          'VALIDATION_FAILED',
          'พิมพ์ชื่อที่ใช้เป็นลายมือชื่อ',
          [{ field: 'text', reason: 'required' }],
        );
      }
    } else {
      const image = readSignatureImage(dto.image);
      if (!image) {
        throw new AppError(
          'VALIDATION_FAILED',
          'ลายมือชื่อต้องเป็นภาพ PNG หรือ JPEG ไม่เกิน 500 KB',
          [{ field: 'image', reason: 'invalid' }],
        );
      }
      signatureKey = `esign/${envelope.id}/signature-${signer.id}.${image.mime === 'image/png' ? 'png' : 'jpg'}`;
      await this.storage.put(signatureKey, image.bytes, {
        contentType: image.mime,
        size: image.bytes.length,
      });
    }
    const done = await this.signers.updateMany({
      where: { id: signer.id, status: 'pending' },
      data: {
        status: 'signed',
        signedAt: new Date(),
        signatureKind: dto.kind,
        signatureKey,
        signatureText,
        authMethod,
        ip: meta.ip,
        userAgent: meta.userAgent,
        tokenUsedAt: signer.kind === 'external' ? new Date() : null,
      },
    });
    if (done.count !== 1) throw new AppError('CONFLICT', 'ลงนามไปแล้ว');
    await this.record(envelope.id, signer.id, 'signed', meta, {
      kind: dto.kind,
      authMethod,
    });

    const after = await this.signersOf(envelope.id);
    if (allSigned(after)) {
      await this.complete(envelope.id);
    } else {
      await this.notifyTurn(envelope, after);
    }
  }

  private async decline(
    signer: SignerRow,
    envelope: EnvelopeRow,
    reason: string,
    meta: RequestMeta,
  ) {
    this.assertPending(signer, envelope);
    const text = reason.trim();
    if (!text) {
      throw new AppError('VALIDATION_FAILED', 'ระบุเหตุผลที่ปฏิเสธ');
    }
    await this.transactions.execute(async (tx) => {
      await tx.esignSigner.update({
        where: { id: signer.id },
        data: {
          status: 'declined',
          declinedAt: new Date(),
          declinedReason: text,
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
      });
      await tx.esignEnvelope.updateMany({
        where: { id: envelope.id, status: 'sent' },
        data: { status: 'declined' },
      });
    });
    await this.record(envelope.id, signer.id, 'declined', meta, {
      reason: text,
    });
    await this.notifications.esignFinished(
      'declined',
      envelope.createdBy,
      envelope.companyId,
      envelope,
      { name: signer.name, reason: text },
    );
  }

  /**
   * CD-169 / CD-170 — everyone signed: seal the PDF with the signatures and
   * the evidence, keep its hash, announce it. Two last signatures at once
   * both seal; only the one that claims the envelope keeps its file.
   */
  async complete(envelopeId: string): Promise<void> {
    const envelope = await this.envelopeById(envelopeId);
    if (envelope.status !== 'sent') return;
    const people = await this.signersOf(envelopeId);
    const fields = readFields(envelope.fields);
    const history = (await this.events.findMany({
      where: { envelopeId },
      orderBy: { at: 'asc' },
    })) as {
      signerId: string | null;
      type: string;
      at: Date;
      ip: string | null;
    }[];
    const completedAt = new Date();
    const sealSigners: SealSigner[] = [];
    for (const signer of people) {
      sealSigners.push({
        fieldKey: signer.fieldKey,
        name: signer.name,
        label: this.roleOf(envelope, signer),
        kind: signer.kind,
        contact: mask(signer.email ?? signer.phone),
        signatureKind: signer.signatureKind ?? 'type',
        signatureImage: signer.signatureKey
          ? {
              mime: signer.signatureKey.endsWith('.png')
                ? 'image/png'
                : 'image/jpeg',
              bytes: await toBuffer(
                await this.storage.get(signer.signatureKey),
              ),
            }
          : null,
        signatureText: signer.signatureText,
        authMethod: signer.authMethod ?? 'keycloak',
        signedAt: signer.signedAt ?? completedAt,
        viewedAt: signer.viewedAt,
        ip: signer.ip,
        userAgent: signer.userAgent,
      });
    }
    const sealed = Buffer.from(
      await seal({
        original: await toBuffer(await this.storage.get(envelope.originalKey)),
        title: envelope.title,
        verifyCode: envelope.verifyCode,
        verifyUrl: `${this.publicUrl()}/v/${envelope.verifyCode}`,
        originalHash: envelope.originalHash,
        createdAt: envelope.createdAt,
        sentAt: envelope.sentAt,
        completedAt,
        fields: fields,
        signers: sealSigners,
        events: history.map((event) => ({
          at: event.at,
          type: event.type,
          ip: event.ip,
          who: people.find((one) => one.id === event.signerId)?.name ?? null,
        })),
      }),
    );
    const signedHash = sha256(sealed);
    const signedKey = `esign/${envelopeId}/signed-${randomUUID().slice(0, 8)}.pdf`;
    await this.storage.put(signedKey, sealed, {
      contentType: 'application/pdf',
      size: sealed.length,
    });
    const claimed = await this.envelopes.updateMany({
      where: { id: envelopeId, status: 'sent' },
      data: { status: 'completed', completedAt, signedKey, signedHash },
    });
    if (claimed.count !== 1) {
      await this.storage.remove(signedKey).catch(() => undefined);
      return;
    }
    await this.record(
      envelopeId,
      null,
      'sealed',
      { ip: null, userAgent: null },
      {
        signedHash,
      },
    );
    await this.domainEvents.emit({
      name: DOMAIN_EVENTS.esignCompleted,
      payload: {
        company_id: envelope.companyId,
        envelope_id: envelopeId,
        source_type: envelope.sourceType,
        source_id: envelope.sourceId,
        ref_type: envelope.refType,
        ref_id: envelope.refId,
      },
    });
    await this.notifications.esignFinished(
      'completed',
      envelope.createdBy,
      envelope.companyId,
      envelope,
    );
  }

  // --- helpers ------------------------------------------------------------------------

  /** Internal signers whose turn it is now and who have not been told. */
  private async notifyTurn(envelope: EnvelopeRow, all: SignerRow[]) {
    const told = new Set(
      (
        (await this.events.findMany({
          where: { envelopeId: envelope.id, type: 'notified' },
          select: { signerId: true },
        })) as { signerId: string | null }[]
      ).map((event) => event.signerId),
    );
    for (const signer of all) {
      if (
        signer.kind !== 'internal' ||
        signer.status !== 'pending' ||
        !signer.userId ||
        told.has(signer.id) ||
        !turnOf(signer, all, envelope.mode).may
      ) {
        continue;
      }
      await this.notifications.esignRequested(
        signer.userId,
        envelope.companyId,
        { id: signer.id, role: this.roleOf(envelope, signer) },
        envelope,
      );
      await this.record(envelope.id, signer.id, 'notified', {
        ip: null,
        userAgent: null,
      });
    }
  }

  private async resolveSigners(
    fields: LayoutField[],
    input: EnvelopeSignerDto[],
    companyId: string,
    document: { docType: string; amount: number | null },
  ) {
    const byKey = new Map(input.map((signer) => [signer.field_key, signer]));
    const problems: string[] = [];
    for (const field of fields) {
      if (!byKey.has(field.key))
        problems.push(`ยังไม่ได้ระบุผู้ลงนาม: ${field.label}`);
    }
    for (const signer of input) {
      if (!fields.some((field) => field.key === signer.field_key)) {
        problems.push(`ไม่มีช่อง ${signer.field_key} ในแม่แบบ`);
      }
    }
    if (problems.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        problems[0],
        problems.map((reason) => ({ field: 'signers', reason })),
      );
    }
    const people: {
      fieldKey: string;
      order: number;
      kind: string;
      userId: string | null;
      name: string;
      email: string | null;
      phone: string | null;
    }[] = [];
    for (const field of fields) {
      const signer = byKey.get(field.key)!;
      if (field.authority && signer.kind !== 'internal') {
        throw new AppError(
          'VALIDATION_FAILED',
          `${field.label}: ต้องเป็นผู้มีอำนาจลงนามของบริษัท (พนักงานในทะเบียน)`,
          [{ field: 'signers', reason: 'authority_internal_only' }],
        );
      }
      if (signer.kind === 'internal') {
        const member = (await this.members.findFirst({
          where: {
            id: signer.user_id ?? '',
            status: 'ACTIVE',
            companies: { some: { companyId } },
          },
          select: { id: true, displayName: true, email: true },
        })) as { id: string; displayName: string; email: string | null } | null;
        if (!member) {
          throw new AppError(
            'VALIDATION_FAILED',
            `${field.label}: ไม่พบผู้ใช้ในบริษัท`,
            [{ field: 'signers', reason: 'unknown_user' }],
          );
        }
        if (field.authority) {
          const verdict = await this.authorities.check(
            companyId,
            member.id,
            document.docType,
            document.amount,
          );
          if (!verdict.ok) {
            throw new AppError(
              'VALIDATION_FAILED',
              `${field.label} (${member.displayName}): ${verdict.reason}`,
              [{ field: 'signers', reason: 'no_authority' }],
            );
          }
        }
        people.push({
          fieldKey: field.key,
          order: field.order,
          kind: 'internal',
          userId: member.id,
          name: member.displayName,
          email: member.email,
          phone: null,
        });
      } else {
        const name = signer.name?.trim();
        if (!name || (!signer.email && !signer.phone)) {
          throw new AppError(
            'VALIDATION_FAILED',
            `${field.label}: ผู้ลงนามภายนอกต้องมีชื่อ และอีเมลหรือเบอร์โทร`,
            [{ field: 'signers', reason: 'external_contact' }],
          );
        }
        people.push({
          fieldKey: field.key,
          order: field.order,
          kind: 'external',
          userId: null,
          name,
          email: signer.email?.trim().toLowerCase() || null,
          phone: signer.phone?.trim() || null,
        });
      }
    }
    return people;
  }

  private async signerView(signer: SignerRow, envelope: EnvelopeRow) {
    const authorityProblem = await this.authorityProblem(signer, envelope);
    return this.signersOf(envelope.id).then((all) => ({
      authorityProblem,
      title: envelope.title,
      message: envelope.message,
      name: signer.name,
      role: this.roleOf(envelope, signer),
      status: signer.status,
      envelopeStatus: this.effectiveStatus(envelope),
      expiresAt: envelope.expiresAt,
      viewed: Boolean(signer.viewedAt),
      turn: turnOf(signer, all, envelope.mode),
      originalName: envelope.originalName,
      verifyCode: envelope.status === 'completed' ? envelope.verifyCode : null,
    }));
  }

  /**
   * CD-172 — a company signatory field whose signer is no longer covered
   * (removed from the register, limit lowered, period over) cannot be signed.
   */
  private async authorityProblem(
    signer: SignerRow,
    envelope: EnvelopeRow,
  ): Promise<string | null> {
    const field = readFields(envelope.fields).find(
      (one) => one.key === signer.fieldKey,
    );
    if (!field?.authority || !signer.userId || signer.status !== 'pending') {
      return null;
    }
    const verdict = await this.authorities.check(
      envelope.companyId,
      signer.userId,
      envelope.docType,
      envelope.amount === null ? null : Number(envelope.amount.toString()),
    );
    return verdict.ok ? null : verdict.reason;
  }

  private async assertAuthority(signer: SignerRow, envelope: EnvelopeRow) {
    const problem = await this.authorityProblem(signer, envelope);
    if (problem) throw new AppError('FORBIDDEN', `ลงนามไม่ได้ — ${problem}`);
  }

  private async byToken(token: string) {
    const signer = (await this.signers.findFirst({
      where: { tokenHash: hashToken(token) },
    })) as SignerRow | null;
    if (!signer) throw new AppError('NOT_FOUND', 'ลิงก์ไม่ถูกต้องหรือใช้แล้ว');
    const envelope = await this.envelopeById(signer.envelopeId);
    return { signer, envelope };
  }

  private async internal(signerId: string, actor: Principal) {
    const signer = (await this.signers.findFirst({
      where: { id: signerId, userId: actor.userId, kind: 'internal' },
    })) as SignerRow | null;
    if (!signer) throw new AppError('NOT_FOUND', 'ไม่พบเอกสารที่ต้องลงนาม');
    const envelope = await this.envelopeById(signer.envelopeId);
    if (envelope.companyId !== actor.activeCompanyId) {
      throw new AppError('NOT_FOUND', 'ไม่พบเอกสารที่ต้องลงนาม');
    }
    return { signer, envelope };
  }

  /** Signing is possible: sent, not expired, this signer still pending. */
  private assertPending(signer: SignerRow, envelope: EnvelopeRow) {
    const status = this.effectiveStatus(envelope);
    if (status === 'expired') {
      throw new AppError('CONFLICT', 'คำขอลงนามหมดอายุแล้ว');
    }
    if (status !== 'sent') {
      throw new AppError('CONFLICT', 'เอกสารนี้ไม่ได้รอลงนามแล้ว');
    }
    if (signer.status !== 'pending') {
      throw new AppError('CONFLICT', 'คุณลงนามหรือปฏิเสธไปแล้ว');
    }
  }

  private verified(signer: SignerRow): boolean {
    return Boolean(
      signer.otpVerifiedAt &&
      Date.now() - signer.otpVerifiedAt.getTime() < OTP_SESSION_MS,
    );
  }

  private assertVerified(signer: SignerRow) {
    if (!this.verified(signer)) {
      throw new AppError('FORBIDDEN', 'ยืนยันตัวตนด้วยรหัสก่อน');
    }
  }

  private effectiveStatus(envelope: EnvelopeRow): string {
    return envelope.status === 'sent' &&
      envelope.expiresAt.getTime() < Date.now()
      ? 'expired'
      : envelope.status;
  }

  private roleOf(envelope: EnvelopeRow, signer: SignerRow): string {
    return (
      readFields(envelope.fields).find((field) => field.key === signer.fieldKey)
        ?.label ?? signer.fieldKey
    );
  }

  private async record(
    envelopeId: string,
    signerId: string | null,
    type: string,
    meta: RequestMeta,
    detail?: Record<string, unknown>,
  ) {
    await this.events.create({
      data: {
        envelopeId,
        signerId,
        type,
        ip: meta.ip,
        userAgent: meta.userAgent?.slice(0, 500) ?? null,
        ...(detail ? { detail: detail as object } : {}),
      },
    });
  }

  private async require(id: string, actor: Principal) {
    const envelope = (await this.envelopes.findFirst({
      where: { id, companyId: actor.activeCompanyId },
    })) as EnvelopeRow | null;
    if (!envelope) throw new AppError('NOT_FOUND', 'ไม่พบเอกสารที่ส่งลงนาม');
    return envelope;
  }

  private async envelopeById(id: string) {
    const row = (await this.envelopes.findFirst({
      where: { id },
    })) as EnvelopeRow | null;
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบเอกสารที่ส่งลงนาม');
    return row;
  }

  private async signerById(id: string) {
    const row = (await this.signers.findFirst({
      where: { id },
    })) as SignerRow | null;
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบผู้ลงนาม');
    return row;
  }

  private async signersOf(envelopeId: string) {
    return (await this.signers.findMany({
      where: { envelopeId },
      orderBy: [{ order: 'asc' }, { fieldKey: 'asc' }],
    })) as SignerRow[];
  }

  private publicUrl(): string {
    return (
      this.config.get<string>('esign.publicUrl') ?? 'http://localhost:3000'
    ).replace(/\/$/, '');
  }

  private secret(): string {
    const secret = this.config.get<string>('esign.secret');
    if (!secret) throw new Error('ESIGN_SECRET is not set');
    return secret;
  }
}
