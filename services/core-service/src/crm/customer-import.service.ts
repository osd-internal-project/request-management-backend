import { Injectable } from '@nestjs/common';
import {
  AuditWriter,
  auditActor,
  Principal,
  PrismaTransactionService,
} from '@request-management/share';
import { CustomerRepository } from './customer.repository';
import { CustomerCodeService } from './customer-code.service';
import { CustomerDedupService } from './customer-dedup.service';
import { CustomerTimelineService } from './customer-timeline.service';
import { isValidThaiTaxId, normalizeCustomerName } from './customer-name';
import {
  CUSTOMER_TYPES,
  ImportCustomerRowDto,
  ImportCustomersDto,
} from './dto/customer.dto';

/** One row's fate, reported back per row — the file never fails as a whole. */
export interface ImportRowResult {
  readonly rowNo: number;
  readonly action: 'create' | 'skip_duplicate' | 'error';
  /** Field-level reasons when `error`; the existing code when `skip`. */
  readonly reasons: readonly string[];
  readonly customerCode?: string;
  readonly headOfficeCode?: string;
}

export interface ImportResult {
  readonly importId: string;
  readonly mode: 'dry_run' | 'commit';
  readonly summary: { create: number; skip: number; error: number };
  readonly results: readonly ImportRowResult[];
}

/**
 * CM-10 — import ลูกค้าเดิมที่ cleansing แล้วจาก Excel (PO 8 ก.ย. 2569).
 *
 * The file is parsed in the browser and arrives as JSON rows; this service is
 * the control: it re-validates everything, answers a full per-row report in
 * `dry_run`, and in `commit` writes row-by-row — each row its own
 * transaction, so a bad row reports and moves on instead of rolling back the
 * good ones (same reasoning as APV-04 batch decisions).
 *
 * Idempotent by (taxId, branchCode): re-running the same file skips every row
 * it already created. Rows without a tax id cannot be deduplicated that way
 * and are always created — the cleansing step owns their uniqueness.
 */
@Injectable()
export class CustomerImportService {
  constructor(
    private readonly customers: CustomerRepository,
    private readonly codes: CustomerCodeService,
    private readonly dedup: CustomerDedupService,
    private readonly timeline: CustomerTimelineService,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
  ) {}

  async run(dto: ImportCustomersDto, actor: Principal): Promise<ImportResult> {
    const results: ImportRowResult[] = [];

    for (const row of dto.rows) {
      results.push(await this.runRow(row, dto, actor));
    }

    const summary = {
      create: results.filter((r) => r.action === 'create').length,
      skip: results.filter((r) => r.action === 'skip_duplicate').length,
      error: results.filter((r) => r.action === 'error').length,
    };

    if (dto.mode === 'commit') {
      // One closing audit entry per batch: what came in, what happened.
      await this.audit.record({
        eventType: 'crm.customer.import_batch',
        companyId: actor.activeCompanyId,
        ...auditActor(actor),
        resourceType: 'customer_import',
        resourceId: dto.import_id,
        after: { rows: dto.rows.length, ...summary },
      });
    }

    return { importId: dto.import_id, mode: dto.mode, summary, results };
  }

  private async runRow(
    row: ImportCustomerRowDto,
    dto: ImportCustomersDto,
    actor: Principal,
  ): Promise<ImportRowResult> {
    const reasons = this.validate(row);
    if (reasons.length) {
      return { rowNo: row.row_no, action: 'error', reasons };
    }

    const branchCode = row.branch_code ?? '00000';

    // Idempotency: the row this file already created (or a pre-existing
    // customer) is a skip, pointing at the existing code.
    if (row.tax_id) {
      const existing = (await this.customers.findFirst({
        where: {
          companyId: actor.activeCompanyId,
          taxId: row.tax_id,
          branchCode,
          mergedIntoCustomerId: null,
        },
        select: { customerCode: true },
      })) as { customerCode: string } | null;

      if (existing) {
        return {
          rowNo: row.row_no,
          action: 'skip_duplicate',
          reasons: [existing.customerCode],
          customerCode: existing.customerCode,
        };
      }
    }

    if (dto.mode === 'dry_run') {
      const head = row.tax_id
        ? await this.dedup.headOfficeOf(row.tax_id, actor.activeCompanyId)
        : null;
      return {
        rowNo: row.row_no,
        action: 'create',
        reasons: [],
        headOfficeCode: head?.customerCode,
      };
    }

    try {
      return await this.transactions.execute(async (prisma) => {
        const head = row.tax_id
          ? await this.dedup.headOfficeOf(
              row.tax_id,
              actor.activeCompanyId,
              prisma,
            )
          : null;
        const customerCode = await this.codes.issue(
          actor.activeCompanyId,
          prisma,
        );

        const created = await this.customers.create(
          {
            data: {
              customerCode,
              companyId: actor.activeCompanyId,
              type: row.type ?? 'corporate',
              nameTh: row.name_th.trim(),
              nameEn: row.name_en?.trim() || null,
              normalizedName: normalizeCustomerName(row.name_th),
              taxId: row.tax_id ?? null,
              branchCode,
              branchName: row.branch_name?.trim() || null,
              headOfficeId: head?.id ?? null,
              status: 'active',
              accountOwnerUserId: actor.userId,
              ownerOrgUnitId: actor.orgUnitId,
              createdBy: actor.userId,
              ...(row.line1?.trim()
                ? {
                    locations: {
                      create: [
                        {
                          name: row.branch_name?.trim() || null,
                          line1: row.line1.trim(),
                          line2: row.line2?.trim() || null,
                          subDistrict: row.sub_district?.trim() || null,
                          district: row.district?.trim() || null,
                          province: row.province?.trim() || null,
                          postalCode: row.postal_code?.trim() || null,
                          isBilling: true,
                          isSite: true,
                          isPrimary: true,
                          createdBy: actor.userId,
                        },
                      ],
                    },
                  }
                : {}),
              ...(row.contact_name?.trim()
                ? {
                    contacts: {
                      create: [
                        {
                          name: row.contact_name.trim(),
                          role: 'other' as const,
                          phone: row.contact_phone?.trim() || null,
                          email: row.contact_email?.trim() || null,
                          isPrimary: true,
                          createdBy: actor.userId,
                        },
                      ],
                    },
                  }
                : {}),
            },
          },
          { prisma },
        );

        // CM-10 AC: every created row names its import on the audit trail.
        await this.audit.record(
          {
            eventType: 'crm.customer.imported',
            companyId: actor.activeCompanyId,
            ...auditActor(actor),
            resourceType: 'customer',
            resourceId: created.id,
            after: {
              importId: dto.import_id,
              rowNo: row.row_no,
              customerCode,
              nameTh: created.nameTh,
              taxId: created.taxId,
            },
          },
          { prisma },
        );

        await this.timeline.publish(
          {
            companyId: actor.activeCompanyId,
            customerId: created.id,
            refType: 'customer',
            refId: created.id,
            eventType: 'customer.created',
            summary: `นำเข้าลูกค้า ${customerCode} · ${created.nameTh} (import ${dto.import_id})`,
            actorId: auditActor(actor).actorId,
            actorName: actor.displayName,
          },
          { prisma },
        );

        return {
          rowNo: row.row_no,
          action: 'create' as const,
          reasons: [],
          customerCode,
          headOfficeCode: head?.customerCode,
        };
      });
    } catch (error) {
      // A race (two batches, same branch) lands here via the DB unique — the
      // row reports and the rest of the file keeps going.
      return {
        rowNo: row.row_no,
        action: 'error',
        reasons: [error instanceof Error ? error.message : String(error)],
      };
    }
  }

  /** The same rules the form enforces, applied to a file row. */
  private validate(row: ImportCustomerRowDto): string[] {
    const reasons: string[] = [];

    if (!row.name_th?.trim()) reasons.push('name_th: required');
    if (row.type && !CUSTOMER_TYPES.includes(row.type)) {
      reasons.push('type: invalid');
    }
    if (row.tax_id) {
      if (!/^\d{13}$/.test(row.tax_id)) reasons.push('tax_id: format');
      else if (!isValidThaiTaxId(row.tax_id)) reasons.push('tax_id: checksum');
    }
    if (row.branch_code && !/^\d{5}$/.test(row.branch_code)) {
      reasons.push('branch_code: format');
    }
    if (row.postal_code && !/^\d{5}$/.test(row.postal_code)) {
      reasons.push('postal_code: format');
    }
    if (
      row.contact_email &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.contact_email)
    ) {
      reasons.push('contact_email: format');
    }

    return reasons;
  }
}
