import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  AppError,
  AuditWriter,
  auditActor,
  Principal,
  PrismaTransactionService,
} from '@request-management/share';
import { CustomerRepository } from './customer.repository';
import { RunNumberClient } from '../run-number/run-number.client';
import { CustomerDedupService } from './customer-dedup.service';
import { CustomerTimelineService } from './customer-timeline.service';
import { CustomerErpSyncService } from './customer-erp-sync.service';
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
  /** The head office is an earlier row of this same file (dry run). */
  readonly headOfficeRow?: number;
  /** Skipped because an earlier row of this file has the same ภาษี+สาขา. */
  readonly duplicateOfRow?: number;
  /**
   * No tax id, but the name matches — an existing customer's code, or an
   * earlier row of the file. A warning only: the row is still created, since
   * the cleansed file owns uniqueness; the dry run is where a person looks.
   */
  readonly possibleDuplicateOf?: string;
  readonly possibleDuplicateOfRow?: number;
}

/** What earlier rows of the same request already claimed. */
interface FileSeen {
  /** `taxId|branchCode` → row number */
  readonly branches: Map<string, number>;
  /** taxId → first row number (a head office candidate in the dry run) */
  readonly taxIds: Map<string, number>;
  /** normalized name of a row without a tax id → row number */
  readonly names: Map<string, number>;
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
 * and are always created — the cleansing step owns their uniqueness — but the
 * dry run flags a name that already exists, so a re-run is visible before it
 * is committed.
 *
 * Every created customer is queued for SAP like one made on the form; queued
 * rather than sent inline, so a file of hundreds does not fire hundreds of
 * SAP calls at once.
 */
@Injectable()
export class CustomerImportService {
  constructor(
    private readonly customers: CustomerRepository,
    private readonly runNumbers: RunNumberClient,
    private readonly dedup: CustomerDedupService,
    private readonly timeline: CustomerTimelineService,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
    private readonly erpSync: CustomerErpSyncService,
  ) {}

  private readonly logger = new Logger(CustomerImportService.name);

  async run(dto: ImportCustomersDto, actor: Principal): Promise<ImportResult> {
    const results: ImportRowResult[] = [];
    const seen: FileSeen = {
      branches: new Map(),
      taxIds: new Map(),
      names: new Map(),
    };

    for (const row of dto.rows) {
      results.push(await this.runRow(row, dto, actor, seen));
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
    seen: FileSeen,
  ): Promise<ImportRowResult> {
    const reasons = this.validate(row);
    if (reasons.length) {
      return { rowNo: row.row_no, action: 'error', reasons };
    }

    const branchCode = row.branch_code ?? '00000';

    // The same ภาษี+สาขา twice in one file: the second is a skip in the dry
    // run too, not only once the first has been written.
    if (row.tax_id) {
      const key = `${row.tax_id}|${branchCode}`;
      const first = seen.branches.get(key);
      if (first !== undefined) {
        return {
          rowNo: row.row_no,
          action: 'skip_duplicate',
          reasons: [],
          duplicateOfRow: first,
        };
      }
      seen.branches.set(key, row.row_no);
    }

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

    const warning = row.tax_id
      ? {}
      : await this.nameWarning(row, actor.activeCompanyId, seen);

    if (dto.mode === 'dry_run') {
      const head = row.tax_id
        ? await this.dedup.headOfficeOf(row.tax_id, actor.activeCompanyId)
        : null;
      // Head office further up this same file — not in the database yet.
      const headRow =
        row.tax_id && !head ? seen.taxIds.get(row.tax_id) : undefined;
      if (row.tax_id && !seen.taxIds.has(row.tax_id)) {
        seen.taxIds.set(row.tax_id, row.row_no);
      }
      return {
        rowNo: row.row_no,
        action: 'create',
        reasons: [],
        headOfficeCode: head?.customerCode,
        ...(headRow !== undefined ? { headOfficeRow: headRow } : {}),
        ...warning,
      };
    }

    try {
      // ออกเลขนอก transaction และหลังตรวจทุกอย่างผ่าน — docs/run-number.md
      const customerCode = await this.runNumbers.issueUnused(
        { companyId: actor.activeCompanyId, docType: 'CUSTOMER' },
        (code) => this.customers.codeTaken(code),
      );

      const result = await this.transactions.execute(async (prisma) => {
        const head = row.tax_id
          ? await this.dedup.headOfficeOf(
              row.tax_id,
              actor.activeCompanyId,
              prisma,
            )
          : null;

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
          customerId: created.id,
        };
      });

      // After the commit, like `create` — a queue row, never a failed import.
      await this.erpSync
        .queueCustomer(result.customerId, 'imported')
        .catch((error: unknown) =>
          this.logger.warn(
            `import ${dto.import_id} row ${row.row_no}: SAP queue failed: ${String(error)}`,
          ),
        );

      const { customerId: _id, ...reported } = result;
      return { ...reported, ...warning };
    } catch (error) {
      return {
        rowNo: row.row_no,
        action: 'error',
        reasons: [this.reasonOf(error, row.row_no, dto.import_id)],
      };
    }
  }

  /**
   * A row's failure as a code the screen can label. A race (two batches, same
   * branch) lands here via the DB unique; anything unexpected is logged in
   * full and reported without leaking Prisma's internals into the report.
   */
  private reasonOf(error: unknown, rowNo: number, importId: string): string {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      return 'duplicate_race';
    }
    // A domain refusal the screen can name; `UNKNOWN` (e.g. run-number
    // unreachable) is an outage, reported like any other.
    if (error instanceof AppError && error.code !== 'UNKNOWN') {
      return error.code;
    }

    this.logger.error(
      `import ${importId} row ${rowNo} failed`,
      error instanceof Error ? error.stack : String(error),
    );
    return 'internal';
  }

  /**
   * CM-10 — a row without a tax id whose normalized name already exists (in
   * the company, or earlier in this file). Name only: a phone or an address
   * written two ways would hide a real duplicate, and a warning costs nothing.
   */
  private async nameWarning(
    row: ImportCustomerRowDto,
    companyId: string,
    seen: FileSeen,
  ): Promise<
    Pick<ImportRowResult, 'possibleDuplicateOf' | 'possibleDuplicateOfRow'>
  > {
    const name = normalizeCustomerName(row.name_th);
    const earlier = seen.names.get(name);
    if (earlier === undefined) seen.names.set(name, row.row_no);

    const existing = (await this.customers.findFirst({
      where: { companyId, normalizedName: name, mergedIntoCustomerId: null },
      select: { customerCode: true },
    })) as { customerCode: string } | null;

    return {
      ...(existing ? { possibleDuplicateOf: existing.customerCode } : {}),
      ...(earlier !== undefined ? { possibleDuplicateOfRow: earlier } : {}),
    };
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
