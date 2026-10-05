import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  AppError,
  AuditWriter,
  auditActor,
  OBJECT_STORAGE,
  Principal,
  PrismaService,
} from '@request-management/share';
import type { ObjectStorage } from '@request-management/share';
import { EsignService, type RequestMeta } from '../esign/esign.service';
import { DOMAIN_EVENTS } from '../events/event-catalog';
import { DomainEventsService } from '../events/domain-events.service';
import { EVIDENCE_TYPES, MAX_EVIDENCE_BYTES } from '../pm/milestones.service';
import { readBoq } from '../presales/solution-rules';
import { safeFileName } from '../requests/attachments.service';
import { certificatePdf } from './certificate-pdf';
import { DeliveriesService } from './deliveries.service';
import { SendCertificateDto } from './delivery.dto';

const day = (value: Date) => value.toISOString().slice(0, 10);
const REF = 'acceptance_certificate';

async function toBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array),
    );
  }
  return Buffer.concat(chunks);
}

interface CertificateRow {
  id: string;
  companyId: string;
  projectId: string;
  acceptanceId: string;
  certificateNo: string;
  status: string;
  source: string;
  draftKey: string | null;
  envelopeId: string | null;
  signedKey: string | null;
  signedName: string | null;
  signedAt: Date | null;
  paperReason: string | null;
}

interface RoundRow {
  id: string;
  projectId: string;
  seq: number;
  milestoneId: string | null;
  status: string;
  decidedOn: Date | null;
  outcomeNote: string | null;
  certificateKey: string | null;
  certificateName: string | null;
  certificateMime: string | null;
}

/**
 * CD-252 ใบรับรองการตรวจรับ (part of CD-20 Delivery).
 *
 * Once a round's result is recorded (accepted, or accepted with conditions,
 * CD-189), the system draws up the company's certificate from it and sends
 * it for signing — the customer's representative and the project manager —
 * through the central e-sign service (CD-14). When everyone has signed, the
 * sealed copy is filed as the round's certificate. A customer that signs on
 * paper is recorded the same way from a scan, with the reason it was not
 * signed electronically. Only a signed certificate lets the phase be billed
 * (CD-253).
 *
 * Who: whoever sees the project's delivery reads; the delivery team, PM or
 * the project's manager draws up, sends, records paper and withdraws.
 */
@Injectable()
export class AcceptanceCertificatesService implements OnModuleInit {
  private readonly logger = new Logger(AcceptanceCertificatesService.name);

  constructor(
    private readonly deliveries: DeliveriesService,
    private readonly esign: EsignService,
    private readonly events: DomainEventsService,
    private readonly prisma: PrismaService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    private readonly audit: AuditWriter,
  ) {}

  onModuleInit(): void {
    this.events.on(DOMAIN_EVENTS.esignCompleted, (event) => {
      const payload = event.payload as {
        envelope_id: string;
        ref_type: string;
        ref_id: string;
      };
      if (payload.ref_type !== REF) return Promise.resolve();
      return this.fileSigned(payload.ref_id, payload.envelope_id).catch(
        (error: Error) =>
          this.logger.warn(`signed certificate not filed: ${error.message}`),
      );
    });
  }

  /** Every decided round of the project with its certificate. */
  async list(actor: Principal, projectId: string) {
    const { project, canEdit } = await this.deliveries.access(actor, projectId);
    const [rounds, certificates, milestones, layouts] = await Promise.all([
      this.rounds(projectId),
      this.prisma.acceptanceCertificate.findMany({ where: { projectId } }),
      this.prisma.projectMilestone.findMany({
        where: { projectId },
        select: { id: true, seq: true, title: true },
      }),
      this.prisma.esignLayout.findMany({
        where: {
          companyId: project.companyId,
          docType: 'acceptance',
          active: true,
        },
        select: { id: true, name: true, fields: true },
        orderBy: { name: 'asc' },
      }),
    ]);
    const byRound = new Map(certificates.map((c) => [c.acceptanceId, c]));
    // internal signers: the project's manager and team
    const members = await this.prisma.projectMember.findMany({
      where: { projectId },
      select: { userId: true },
    });
    const managerId = (
      await this.prisma.project.findUnique({
        where: { id: projectId },
        select: { managerUserId: true },
      })
    )?.managerUserId;
    const people = await this.prisma.user.findMany({
      where: {
        id: {
          in: [...new Set([managerId, ...members.map((m) => m.userId)])].filter(
            (id): id is string => !!id,
          ),
        },
      },
      select: { id: true, displayName: true },
    });
    return {
      canManage: canEdit,
      people: people.map((p) => ({ id: p.id, name: p.displayName })),
      layouts: layouts.map((layout) => ({
        id: layout.id,
        name: layout.name,
        fields: Array.isArray(layout.fields)
          ? (layout.fields as { key: string; label: string }[]).map((f) => ({
              key: f.key,
              label: f.label,
            }))
          : [],
      })),
      rounds: rounds
        .filter((r) => r.status === 'accepted' || r.status === 'conditional')
        .map((round) => {
          const cert = byRound.get(round.id) as CertificateRow | undefined;
          const milestone = milestones.find((m) => m.id === round.milestoneId);
          return {
            acceptanceId: round.id,
            label: `A-${round.seq}`,
            phase: milestone ? `${milestone.seq}. ${milestone.title}` : null,
            result: round.status,
            decidedOn: round.decidedOn ? day(round.decidedOn) : null,
            uploadedCertificate: round.certificateName,
            certificate: cert
              ? {
                  id: cert.id,
                  certificateNo: cert.certificateNo,
                  status: cert.status,
                  source: cert.source,
                  envelopeId: cert.envelopeId,
                  signedName: cert.signedName,
                  signedAt: cert.signedAt,
                  paperReason: cert.paperReason,
                }
              : null,
          };
        }),
    };
  }

  /** Draw up (or draw up again, while not sent) the round's certificate. */
  async generate(actor: Principal, projectId: string, acceptanceId: string) {
    const { project } = await this.manage(actor, projectId);
    const round = await this.decidedRound(projectId, acceptanceId);
    const existing = (await this.prisma.acceptanceCertificate.findUnique({
      where: { acceptanceId },
    })) as CertificateRow | null;
    if (
      existing &&
      (existing.status === 'sent' || existing.status === 'signed')
    ) {
      throw new AppError(
        'CONFLICT',
        existing.status === 'signed'
          ? 'ใบรับรองของรอบนี้ลงนามแล้ว'
          : 'ใบรับรองส่งลงนามอยู่ — ถอนก่อนจึงสร้างใหม่ได้',
      );
    }
    const certificateNo = `AC-${project.projectNo}-${round.seq}`;
    const pdf = await certificatePdf(
      await this.facts(project.companyId, projectId, round, certificateNo),
    );
    const draftKey = `projects/${projectId}/acceptances/${acceptanceId}/certificate-${randomUUID().slice(0, 8)}.pdf`;
    await this.storage.put(draftKey, pdf, {
      contentType: 'application/pdf',
      size: pdf.length,
    });
    await this.prisma.acceptanceCertificate.upsert({
      where: { acceptanceId },
      create: {
        companyId: project.companyId,
        projectId,
        acceptanceId,
        milestoneId: round.milestoneId,
        certificateNo,
        status: 'draft',
        draftKey,
        createdBy: actor.userId,
      },
      update: {
        status: 'draft',
        source: 'esign',
        draftKey,
        envelopeId: null,
        paperReason: null,
        updatedBy: actor.userId,
      },
    });
    if (existing?.draftKey) {
      await this.storage.remove(existing.draftKey).catch(() => undefined);
    }
    await this.audit.record({
      eventType: 'delivery.certificate.drafted',
      companyId: project.companyId,
      ...auditActor(actor),
      resourceType: 'project',
      resourceId: projectId,
      after: { acceptanceId, certificateNo },
    });
    return this.list(actor, projectId);
  }

  /** Send the drafted certificate for signing (customer + manager). */
  async send(
    actor: Principal,
    projectId: string,
    acceptanceId: string,
    dto: SendCertificateDto,
    meta: RequestMeta,
  ) {
    const { project } = await this.manage(actor, projectId);
    const cert = await this.requireCertificate(projectId, acceptanceId);
    if (cert.status !== 'draft' || !cert.draftKey) {
      throw new AppError('CONFLICT', 'ส่งลงนามได้เฉพาะใบรับรองที่ร่างไว้');
    }
    const envelope = (await this.esign.create(
      {
        companyId: project.companyId,
        title: `ใบรับรองการตรวจรับ ${cert.certificateNo} · ${project.projectNo}`,
        pdf: await toBuffer(await this.storage.get(cert.draftKey)),
        originalName: `${cert.certificateNo}.pdf`,
        sourceType: REF,
        sourceId: cert.id,
        refType: REF,
        refId: cert.id,
        layoutId: dto.layout_id,
        amount: null,
        mode: dto.mode,
        expiresInDays: dto.expires_in_days,
        message: dto.message,
        signers: dto.signers,
      },
      actor,
    )) as { id: string };
    // External signers' one-time links: shown once, passed on by hand (no email yet).
    const sent = (await this.esign.send(envelope.id, actor, meta)) as {
      links?: { signerId: string; name: string; link: string }[];
    };
    await this.prisma.acceptanceCertificate.update({
      where: { id: cert.id },
      data: {
        status: 'sent',
        envelopeId: envelope.id,
        updatedBy: actor.userId,
      },
    });
    await this.audit.record({
      eventType: 'delivery.certificate.sent',
      companyId: project.companyId,
      ...auditActor(actor),
      resourceType: 'project',
      resourceId: projectId,
      after: {
        acceptanceId,
        envelopeId: envelope.id,
        signers: dto.signers.length,
      },
    });
    return { ...(await this.list(actor, projectId)), links: sent.links ?? [] };
  }

  /** Take back a certificate sent for signing (its envelope is cancelled). */
  async withdraw(
    actor: Principal,
    projectId: string,
    acceptanceId: string,
    reason: string,
  ) {
    const { project } = await this.manage(actor, projectId);
    const cert = await this.requireCertificate(projectId, acceptanceId);
    if (cert.status !== 'sent' || !cert.envelopeId) {
      throw new AppError('CONFLICT', 'ใบรับรองนี้ไม่ได้อยู่ระหว่างลงนาม');
    }
    if (!reason.trim()) {
      throw new AppError('VALIDATION_FAILED', 'ต้องระบุเหตุผลที่ถอน');
    }
    await this.esign.cancel(cert.envelopeId, reason.trim(), actor);
    await this.prisma.acceptanceCertificate.update({
      where: { id: cert.id },
      data: { status: 'cancelled', updatedBy: actor.userId },
    });
    await this.audit.record({
      eventType: 'delivery.certificate.withdrawn',
      companyId: project.companyId,
      ...auditActor(actor),
      resourceType: 'project',
      resourceId: projectId,
      after: { acceptanceId, reason: reason.trim() },
    });
    return this.list(actor, projectId);
  }

  /**
   * A certificate the customer signed on paper: a scan (or the file attached
   * when the result was recorded) and why it was not signed electronically.
   */
  async paper(
    actor: Principal,
    projectId: string,
    acceptanceId: string,
    reason: string,
    file:
      | { originalname: string; mimetype: string; size: number; buffer: Buffer }
      | undefined,
  ) {
    const { project } = await this.manage(actor, projectId);
    const round = await this.decidedRound(projectId, acceptanceId);
    const existing = (await this.prisma.acceptanceCertificate.findUnique({
      where: { acceptanceId },
    })) as CertificateRow | null;
    if (existing?.status === 'signed') {
      throw new AppError('CONFLICT', 'ใบรับรองของรอบนี้ลงนามแล้ว');
    }
    if (existing?.status === 'sent') {
      throw new AppError('CONFLICT', 'ใบรับรองส่งลงนามอยู่ — ถอนก่อน');
    }
    const problems: string[] = [];
    if (!reason.trim())
      problems.push('ต้องระบุเหตุผลที่ไม่ลงนามอิเล็กทรอนิกส์');
    if (!file && !round.certificateKey)
      problems.push('ต้องแนบไฟล์สแกนใบรับรองที่ลูกค้าลงนาม');
    if (file && !(EVIDENCE_TYPES as readonly string[]).includes(file.mimetype))
      problems.push('แนบได้เฉพาะ PDF หรือรูปภาพ');
    if (file && file.size > MAX_EVIDENCE_BYTES)
      problems.push('ไฟล์ใหญ่เกิน 25 MB');
    if (problems.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        problems[0],
        problems.map((r) => ({ field: 'certificate', reason: r })),
      );
    }
    let signed = {
      key: round.certificateKey!,
      name: round.certificateName ?? 'certificate',
      size: null as number | null,
    };
    if (file) {
      const name = safeFileName(file.originalname);
      const key = `projects/${projectId}/acceptances/${acceptanceId}/${randomUUID()}/${name}`;
      await this.storage.put(key, file.buffer, {
        contentType: file.mimetype,
        size: file.size,
      });
      signed = { key, name, size: file.size };
      // the round shows it as its certificate too, if it had none
      await this.prisma.projectAcceptance.updateMany({
        where: { id: acceptanceId, certificateKey: null },
        data: {
          certificateKey: key,
          certificateName: name,
          certificateMime: file.mimetype,
          certificateSize: file.size,
        },
      });
    }
    const certificateNo =
      existing?.certificateNo ?? `AC-${project.projectNo}-${round.seq}`;
    await this.prisma.acceptanceCertificate.upsert({
      where: { acceptanceId },
      create: {
        companyId: project.companyId,
        projectId,
        acceptanceId,
        milestoneId: round.milestoneId,
        certificateNo,
        status: 'signed',
        source: 'paper',
        signedKey: signed.key,
        signedName: signed.name,
        signedSize: signed.size,
        signedAt: new Date(),
        paperReason: reason.trim(),
        createdBy: actor.userId,
      },
      update: {
        status: 'signed',
        source: 'paper',
        signedKey: signed.key,
        signedName: signed.name,
        signedSize: signed.size,
        signedAt: new Date(),
        paperReason: reason.trim(),
        updatedBy: actor.userId,
      },
    });
    await this.audit.record({
      eventType: 'delivery.certificate.paper',
      companyId: project.companyId,
      ...auditActor(actor),
      resourceType: 'project',
      resourceId: projectId,
      after: {
        acceptanceId,
        certificateNo,
        reason: reason.trim(),
        fileName: signed.name,
      },
    });
    return this.list(actor, projectId);
  }

  /** The draft or the signed copy, as a file. */
  async file(
    actor: Principal,
    projectId: string,
    acceptanceId: string,
    which: 'draft' | 'signed',
  ): Promise<{ stream: Readable; fileName: string; mimeType: string }> {
    await this.deliveries.access(actor, projectId);
    const cert = await this.requireCertificate(projectId, acceptanceId);
    const key = which === 'draft' ? cert.draftKey : cert.signedKey;
    if (!key) throw new AppError('NOT_FOUND', 'ยังไม่มีไฟล์นี้');
    const name =
      which === 'draft'
        ? `${cert.certificateNo}-draft.pdf`
        : (cert.signedName ?? `${cert.certificateNo}.pdf`);
    return {
      stream: await this.storage.get(key),
      fileName: name,
      mimeType: name.toLowerCase().endsWith('.pdf')
        ? 'application/pdf'
        : 'application/octet-stream',
    };
  }

  /** CD-253 — whether a round's certificate is signed (e-sign or paper). */
  async isSigned(acceptanceId: string) {
    return (
      (await this.prisma.acceptanceCertificate.count({
        where: { acceptanceId, status: 'signed' },
      })) > 0
    );
  }

  // --- helpers ----------------------------------------------------------------

  /** Everyone signed: keep the sealed copy as the round's certificate. */
  async fileSigned(certificateId: string, envelopeId: string) {
    const cert = (await this.prisma.acceptanceCertificate.findUnique({
      where: { id: certificateId },
    })) as CertificateRow | null;
    if (!cert || cert.envelopeId !== envelopeId || cert.status === 'signed')
      return;
    const bytes = await this.esign.signedBytes(envelopeId);
    const name = `${cert.certificateNo}-signed.pdf`;
    const key = `projects/${cert.projectId}/acceptances/${cert.acceptanceId}/${randomUUID()}/${name}`;
    await this.storage.put(key, bytes, {
      contentType: 'application/pdf',
      size: bytes.length,
    });
    const claimed = await this.prisma.acceptanceCertificate.updateMany({
      where: { id: cert.id, status: 'sent' },
      data: {
        status: 'signed',
        signedKey: key,
        signedName: name,
        signedSize: bytes.length,
        signedAt: (await this.esign.completedAt(envelopeId)) ?? new Date(),
      },
    });
    if (!claimed.count) {
      await this.storage.remove(key).catch(() => undefined);
      return;
    }
    // the round's certificate, if it had none
    await this.prisma.projectAcceptance.updateMany({
      where: { id: cert.acceptanceId, certificateKey: null },
      data: {
        certificateKey: key,
        certificateName: name,
        certificateMime: 'application/pdf',
        certificateSize: bytes.length,
      },
    });
    await this.audit.record({
      eventType: 'delivery.certificate.signed',
      companyId: cert.companyId,
      actorId: null,
      actorUsername: 'esign',
      resourceType: 'project',
      resourceId: cert.projectId,
      after: { acceptanceId: cert.acceptanceId, envelopeId },
    });
  }

  private async manage(actor: Principal, projectId: string) {
    const access = await this.deliveries.access(actor, projectId);
    if (!access.canEdit) {
      throw new AppError(
        'FORBIDDEN',
        'จัดการใบรับรองได้เฉพาะทีม Delivery หรือผู้จัดการโครงการ ขณะโครงการดำเนินอยู่',
      );
    }
    return access;
  }

  private rounds(projectId: string) {
    return this.prisma.projectAcceptance.findMany({
      where: { projectId },
      select: {
        id: true,
        projectId: true,
        seq: true,
        milestoneId: true,
        status: true,
        decidedOn: true,
        outcomeNote: true,
        certificateKey: true,
        certificateName: true,
        certificateMime: true,
      },
      orderBy: { seq: 'asc' },
    }) as Promise<RoundRow[]>;
  }

  private async decidedRound(projectId: string, acceptanceId: string) {
    const round = (await this.rounds(projectId)).find(
      (r) => r.id === acceptanceId,
    );
    if (!round) throw new AppError('NOT_FOUND', 'ไม่พบรอบตรวจรับที่ระบุ');
    if (round.status !== 'accepted' && round.status !== 'conditional') {
      throw new AppError(
        'CONFLICT',
        'ออกใบรับรองได้เฉพาะรอบที่บันทึกผลรับมอบ หรือรับมอบโดยมีเงื่อนไขแล้ว',
      );
    }
    return round;
  }

  private async requireCertificate(projectId: string, acceptanceId: string) {
    const cert = (await this.prisma.acceptanceCertificate.findFirst({
      where: { projectId, acceptanceId },
    })) as CertificateRow | null;
    if (!cert) throw new AppError('NOT_FOUND', 'ยังไม่มีใบรับรองของรอบนี้');
    return cert;
  }

  /** What the certificate says, read from the project, its contract and the round. */
  private async facts(
    companyId: string,
    projectId: string,
    round: RoundRow,
    certificateNo: string,
  ) {
    const [company, project, milestone, items, lines] = await Promise.all([
      this.prisma.company.findUnique({
        where: { id: companyId },
        select: { name: true },
      }),
      this.prisma.project.findUnique({
        where: { id: projectId },
        select: {
          projectNo: true,
          name: true,
          baseline: true,
          contract: {
            select: {
              contractNo: true,
              counterpartyName: true,
              customer: { select: { nameTh: true } },
            },
          },
        },
      }),
      round.milestoneId
        ? this.prisma.projectMilestone.findUnique({
            where: { id: round.milestoneId },
            select: { seq: true, title: true },
          })
        : Promise.resolve(null),
      this.prisma.projectAcceptanceItem.findMany({
        where: { acceptanceId: round.id },
        select: { text: true, dueOn: true },
        orderBy: { seq: 'asc' },
      }),
      round.milestoneId
        ? this.prisma.projectDeliveryLine.findMany({
            where: {
              delivery: {
                projectId,
                milestoneId: round.milestoneId,
                status: { not: 'cancelled' },
              },
            },
            select: { boqIndex: true, quantity: true },
          })
        : Promise.resolve([]),
    ]);
    const boq = readBoq((project?.baseline as { boq?: unknown } | null)?.boq);
    const totals = new Map<number, number>();
    for (const line of lines)
      totals.set(
        line.boqIndex,
        (totals.get(line.boqIndex) ?? 0) + Number(line.quantity),
      );
    return {
      companyName: company?.name ?? '',
      certificateNo,
      projectNo: project?.projectNo ?? '',
      projectName: project?.name ?? '',
      contractNo: project?.contract?.contractNo ?? null,
      customerName:
        project?.contract?.customer?.nameTh ??
        project?.contract?.counterpartyName ??
        null,
      phase: milestone
        ? `${milestone.seq}. ${milestone.title}`
        : `รอบตรวจรับ A-${round.seq}`,
      decidedOn: round.decidedOn ? day(round.decidedOn) : day(new Date()),
      result: round.status as 'accepted' | 'conditional',
      note: round.outcomeNote,
      deliverables: [...totals.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([index, qty]) => {
          const item = boq[index];
          return item
            ? `${item.name || item.productCode} × ${qty}${item.unit ? ` ${item.unit}` : ''}`
            : `BOQ ${index + 1} × ${qty}`;
        }),
      openPoints: items.map((i) => ({ text: i.text, dueOn: day(i.dueOn) })),
    };
  }
}
