import { Injectable } from '@nestjs/common';
import {
  AuditWriter,
  auditActor,
  Principal,
  PrismaTransactionService,
} from '@request-management/share';
import { LeadRepository } from './sales.repositories';
import { ImportLeadRowDto, ImportLeadsDto } from './dto/sales.dto';

export interface LeadImportRowResult {
  readonly rowNo: number;
  readonly action: 'create' | 'skip_duplicate' | 'error';
  readonly reasons: readonly string[];
  readonly leadId?: string;
}

export interface LeadImportResult {
  readonly importId: string;
  readonly mode: 'dry_run' | 'commit';
  readonly summary: { create: number; skip: number; error: number };
  readonly results: readonly LeadImportRowResult[];
}

/**
 * Import Lead จาก Excel — the same contract as the CM-10 customer import:
 * the browser parses, this service is the control; `dry_run` answers the full
 * per-row report without writing; `commit` writes row-by-row so a bad row
 * reports and moves on.
 *
 * Idempotent by contact channel: a row whose email OR phone already belongs
 * to a lead in this company is a skip pointing at it — re-running the same
 * event file cannot fill the register with duplicates. Rows with neither
 * channel are always created; the cleansing step owns their uniqueness.
 */
@Injectable()
export class LeadImportService {
  constructor(
    private readonly leads: LeadRepository,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
  ) {}

  async run(dto: ImportLeadsDto, actor: Principal): Promise<LeadImportResult> {
    const results: LeadImportRowResult[] = [];

    for (const row of dto.rows) {
      results.push(await this.runRow(row, dto, actor));
    }

    const summary = {
      create: results.filter((r) => r.action === 'create').length,
      skip: results.filter((r) => r.action === 'skip_duplicate').length,
      error: results.filter((r) => r.action === 'error').length,
    };

    if (dto.mode === 'commit') {
      await this.audit.record({
        eventType: 'crm.lead.import_batch',
        companyId: actor.activeCompanyId,
        ...auditActor(actor),
        resourceType: 'lead_import',
        resourceId: dto.import_id,
        after: { rows: dto.rows.length, ...summary },
      });
    }

    return { importId: dto.import_id, mode: dto.mode, summary, results };
  }

  private async runRow(
    row: ImportLeadRowDto,
    dto: ImportLeadsDto,
    actor: Principal,
  ): Promise<LeadImportRowResult> {
    const reasons = this.validate(row);
    if (reasons.length) {
      return { rowNo: row.row_no, action: 'error', reasons };
    }

    const email = row.email?.trim() || null;
    const phone = row.phone?.trim() || null;

    if (email || phone) {
      const existing = (await this.leads.findFirst({
        where: {
          companyId: actor.activeCompanyId,
          OR: [
            ...(email ? [{ email }] : []),
            ...(phone ? [{ phone }] : []),
          ],
        },
        select: { id: true, name: true },
      })) as { id: string; name: string } | null;

      if (existing) {
        return {
          rowNo: row.row_no,
          action: 'skip_duplicate',
          reasons: [existing.name],
          leadId: existing.id,
        };
      }
    }

    if (dto.mode === 'dry_run') {
      return { rowNo: row.row_no, action: 'create', reasons: [] };
    }

    try {
      return await this.transactions.execute(async (prisma) => {
        const created = (await this.leads.create(
          {
            data: {
              companyId: actor.activeCompanyId,
              name: row.name.trim(),
              contactName: row.contact_name?.trim() || null,
              phone,
              email,
              sourceCode: row.source_code?.trim() || null,
              note: row.note?.trim() || null,
              ownerUserId: actor.userId,
              ownerOrgUnitId: actor.orgUnitId,
              createdBy: actor.userId,
            },
          },
          { prisma },
        )) as { id: string };

        await this.audit.record(
          {
            eventType: 'crm.lead.imported',
            companyId: actor.activeCompanyId,
            ...auditActor(actor),
            resourceType: 'lead',
            resourceId: created.id,
            after: {
              importId: dto.import_id,
              rowNo: row.row_no,
              name: row.name,
              sourceCode: row.source_code ?? null,
            },
          },
          { prisma },
        );

        return {
          rowNo: row.row_no,
          action: 'create' as const,
          reasons: [],
          leadId: created.id,
        };
      });
    } catch (error) {
      return {
        rowNo: row.row_no,
        action: 'error',
        reasons: [error instanceof Error ? error.message : String(error)],
      };
    }
  }

  private validate(row: ImportLeadRowDto): string[] {
    const reasons: string[] = [];

    if (!row.name?.trim()) reasons.push('name: required');
    if (row.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email.trim())) {
      reasons.push('email: format');
    }
    if (row.phone && !/^[\d\s+-]{6,}$/.test(row.phone.trim())) {
      reasons.push('phone: format');
    }

    return reasons;
  }
}
