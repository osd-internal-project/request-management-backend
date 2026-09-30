import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  AppError,
  AuditWriter,
  OBJECT_STORAGE,
  Principal,
} from '@request-management/share';
import type { ObjectStorage } from '@request-management/share';
import { EsignService } from '../esign/esign.service';
import type { CreateContractEnvelopeDto } from '../esign/esign.dto';
import { DomainEventsService } from '../events/domain-events.service';
import { DOMAIN_EVENTS } from '../events/event-catalog';
import { contractVisibleWhere } from './contract-visibility';
import { extractContractText } from './contract-text';
import { ContractDraftsService } from './contract-drafts.service';
import { ContractDraftApprovalService } from './contract-draft-approval.service';
import {
  ContractDocumentRepository,
  CustomerContractRepository,
} from './contract.repositories';

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
 * CD-160 (ลงนามสัญญา) over CD-14: Legal sends a PDF of the contract
 * repository for signing; when every party has signed, the sealed copy is
 * filed back in the repository next to the original — "เอกสารฉบับลงนามเก็บ
 * อยู่ในคลังสัญญาเดียวกับต้นฉบับ".
 */
@Injectable()
export class ContractEsignService implements OnModuleInit {
  private readonly logger = new Logger(ContractEsignService.name);

  constructor(
    private readonly esign: EsignService,
    private readonly contracts: CustomerContractRepository,
    private readonly documents: ContractDocumentRepository,
    private readonly events: DomainEventsService,
    private readonly audit: AuditWriter,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    private readonly drafts: ContractDraftsService,
    private readonly approvals: ContractDraftApprovalService,
  ) {}

  onModuleInit(): void {
    this.events.on(DOMAIN_EVENTS.esignCompleted, (event) => {
      const payload = event.payload as {
        envelope_id: string;
        ref_type: string;
        ref_id: string;
        company_id: string;
      };
      if (payload.ref_type !== 'contract') return Promise.resolve();
      return this.fileSigned(payload).catch((error: Error) =>
        this.logger.warn(`signed contract not filed: ${error.message}`),
      );
    });
  }

  async send(
    contractId: string,
    dto: CreateContractEnvelopeDto,
    actor: Principal,
  ) {
    const contract = await this.requireContract(contractId, actor);
    await this.assertApproved(contract, actor);
    const document = (await this.documents.findFirst({
      where: { id: dto.document_id, contractId, deletedAt: null },
      select: { id: true, fileName: true, mimeType: true, storageKey: true },
    })) as {
      id: string;
      fileName: string;
      mimeType: string;
      storageKey: string;
    } | null;
    if (!document) throw new AppError('NOT_FOUND', 'ไม่พบไฟล์ที่ระบุ');
    if (document.mimeType !== 'application/pdf') {
      throw new AppError('VALIDATION_FAILED', 'ส่งลงนามได้เฉพาะไฟล์ PDF', [
        { field: 'document_id', reason: document.mimeType },
      ]);
    }
    return this.esign.create(
      {
        companyId: contract.companyId,
        title: `${contract.contractNo} · ${contract.title}`,
        pdf: await toBuffer(await this.storage.get(document.storageKey)),
        originalName: document.fileName,
        sourceType: 'contract_document',
        sourceId: document.id,
        refType: 'contract',
        refId: contract.id,
        layoutId: dto.layout_id,
        // CD-172 — the company's signatories are checked against this
        amount:
          contract.value === null ? null : Number(contract.value.toString()),
        mode: dto.mode,
        expiresInDays: dto.expires_in_days,
        message: dto.message,
        signers: dto.signers,
      },
      actor,
    );
  }

  async list(contractId: string, actor: Principal) {
    await this.requireContract(contractId, actor);
    return this.esign.listFor('contract', contractId, actor);
  }

  private async fileSigned(payload: {
    envelope_id: string;
    ref_id: string;
    company_id: string;
  }) {
    const bytes = await this.esign.signedBytes(payload.envelope_id);
    const source = (await this.documents.findFirst({
      where: { contractId: payload.ref_id },
      orderBy: { uploadedAt: 'desc' },
      select: { fileName: true, uploadedBy: true },
    })) as { fileName: string; uploadedBy: string } | null;
    const id = randomUUID();
    const fileName =
      (source?.fileName ?? 'contract.pdf').replace(/\.pdf$/i, '') +
      '-signed.pdf';
    const storageKey = `contracts/${payload.ref_id}/${id}/${fileName}`;
    await this.storage.put(storageKey, bytes, {
      contentType: 'application/pdf',
      size: bytes.length,
    });
    const { status, text } = await extractContractText(
      bytes,
      'application/pdf',
    );
    await this.documents.create({
      data: {
        id,
        companyId: payload.company_id,
        contractId: payload.ref_id,
        fileName,
        mimeType: 'application/pdf',
        sizeBytes: bytes.length,
        storageKey,
        textStatus: status,
        textContent: text,
        uploadedBy: source?.uploadedBy ?? 'esign',
      },
    });
    await this.audit.record({
      eventType: 'legal.contract.signed_filed',
      companyId: payload.company_id,
      actorId: null,
      actorUsername: 'esign',
      resourceType: 'customer_contract',
      resourceId: payload.ref_id,
      after: { envelopeId: payload.envelope_id, documentId: id },
    });
  }

  /**
   * CD-160 — a contract drafted in the system (CD-146) is signed only once
   * its draft is approved (CD-159: routed on value and risk, and voided by
   * any later edit). One recorded without a draft is Legal's to send.
   */
  private async assertApproved(
    contract: { requestId: string | null },
    actor: Principal,
  ) {
    if (!contract.requestId) return;
    const found = await this.drafts.forRequest(contract.requestId, actor);
    if (!found.draft) return;
    const approval = await this.approvals.view(found.draft.id, actor);
    if (approval.approvedVersionNo === null) {
      throw new AppError(
        'CONFLICT',
        'ร่างสัญญายังไม่ได้รับอนุมัติ — ขออนุมัติที่หน้าร่างสัญญาก่อนส่งลงนาม',
      );
    }
  }

  private async requireContract(id: string, actor: Principal) {
    const found = (await this.contracts.findFirst({
      where: {
        id,
        companyId: actor.activeCompanyId,
        ...contractVisibleWhere(actor),
      },
      select: {
        id: true,
        companyId: true,
        contractNo: true,
        title: true,
        value: true,
        requestId: true,
      },
    })) as {
      id: string;
      companyId: string;
      contractNo: string;
      title: string;
      value: { toString(): string } | null;
      requestId: string | null;
    } | null;
    if (!found) throw new AppError('NOT_FOUND', 'ไม่พบสัญญาที่ระบุ');
    return found;
  }
}
