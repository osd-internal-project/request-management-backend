import { Injectable } from '@nestjs/common';
import {
  AppError,
  AuditWriter,
  auditActor,
  customerAccessSubject,
  Principal,
  PrismaTransactionService,
  visibleCustomersWhere,
} from '@request-management/share';
import { CustomerRepository } from './customer.repository';
import { normalizeCustomerName } from './customer-name';
import {
  CustomerKycRecordRepository,
  KycWatchlistRepository,
} from './kyc.repositories';
import { screenAgainst, suggestRisk, type WatchlistEntry } from './kyc-rules';

const ENTRY_SELECT = {
  id: true,
  name: true,
  normalizedName: true,
  taxId: true,
  reason: true,
} as const;

/**
 * CD-61 — the prohibited list (CRM settings) and a customer's KYC as the
 * 360° page shows it: the verifications on record and a live screening, so a
 * reviewer sees any match before closing the KYC request.
 */
@Injectable()
export class KycService {
  constructor(
    private readonly customers: CustomerRepository,
    private readonly records: CustomerKycRecordRepository,
    private readonly watchlist: KycWatchlistRepository,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
  ) {}

  /** The customer's KYC: current state, live screening, and every record. */
  async customerKyc(id: string, actor: Principal) {
    const customer = (await this.customers.findFirst({
      where: {
        id,
        AND: [visibleCustomersWhere(customerAccessSubject(actor))],
      },
      select: {
        id: true,
        companyId: true,
        nameTh: true,
        nameEn: true,
        taxId: true,
        kycVerified: true,
        kycVerifiedAt: true,
        kycRiskLevel: true,
        kycExpiresOn: true,
      },
    })) as {
      id: string;
      companyId: string;
      nameTh: string;
      nameEn: string | null;
      taxId: string | null;
      kycVerified: boolean;
      kycVerifiedAt: Date | null;
      kycRiskLevel: string | null;
      kycExpiresOn: Date | null;
    } | null;
    // SCOPE-03: out of reach answers 404.
    if (!customer) throw new AppError('NOT_FOUND', 'ไม่พบลูกค้าที่ระบุ');

    const [entries, records] = await Promise.all([
      this.watchlist.findMany({
        where: { companyId: customer.companyId, active: true },
        select: ENTRY_SELECT,
      }) as Promise<WatchlistEntry[]>,
      this.records.findMany({
        where: { customerId: id },
        orderBy: { recordedAt: 'desc' },
      }),
    ]);
    const matches = screenAgainst(customer, entries);

    return {
      verified: customer.kycVerified,
      verifiedAt: customer.kycVerifiedAt,
      riskLevel: customer.kycRiskLevel,
      expiresOn: customer.kycExpiresOn,
      screening: {
        matches,
        // Documents are judged when the KYC request closes; here only the list.
        suggestedRisk: suggestRisk({ matches, missingDocs: [] }),
      },
      records,
    };
  }

  // --- the prohibited list (admin.crm.manage) ------------------------------

  listWatchlist(actor: Principal, includeInactive = false) {
    return this.watchlist.findMany({
      where: {
        companyId: actor.activeCompanyId,
        ...(includeInactive ? {} : { active: true }),
      },
      orderBy: [{ active: 'desc' }, { createdAt: 'desc' }],
    });
  }

  /** Adds one or many (a pasted/imported list). Audited as one change. */
  async addToWatchlist(
    entries: {
      name: string;
      tax_id?: string;
      reason: string;
      source?: string;
    }[],
    actor: Principal,
  ) {
    const rows = entries.map((entry) => ({
      companyId: actor.activeCompanyId,
      name: entry.name.trim(),
      normalizedName: normalizeCustomerName(entry.name),
      taxId: entry.tax_id?.replace(/\D/g, '') || null,
      reason: entry.reason.trim(),
      source: entry.source?.trim() || null,
      createdBy: actor.userId,
      updatedBy: actor.userId,
    }));
    const empty = rows.find((row) => !row.name || !row.reason);
    if (empty) {
      throw new AppError('VALIDATION_FAILED', 'ทุกรายการต้องมีชื่อและเหตุผล', [
        { field: 'entries', reason: 'name_and_reason_required' },
      ]);
    }

    return this.transactions.execute(async (prisma) => {
      await this.watchlist.createMany({ data: rows }, { prisma });
      await this.audit.record(
        {
          eventType: 'crm.kyc_watchlist.added',
          companyId: actor.activeCompanyId,
          ...auditActor(actor),
          resourceType: 'kyc_watchlist',
          resourceId: actor.activeCompanyId,
          after: rows.map(({ name, taxId, reason, source }) => ({
            name,
            taxId,
            reason,
            source,
          })),
        },
        { prisma },
      );
      return { added: rows.length };
    });
  }

  /** Deactivated, never deleted — a KYC record keeps the entry it matched. */
  async deactivateWatchlistEntry(id: string, actor: Principal) {
    const found = (await this.watchlist.findFirst({
      where: { id, companyId: actor.activeCompanyId },
    })) as { id: string; name: string; active: boolean } | null;
    if (!found) throw new AppError('NOT_FOUND', 'ไม่พบรายการที่ระบุ');
    if (!found.active) return found;

    return this.transactions.execute(async (prisma) => {
      const updated = await this.watchlist.update(
        {
          where: { id },
          data: { active: false, updatedBy: actor.userId },
        },
        { prisma },
      );
      await this.audit.record(
        {
          eventType: 'crm.kyc_watchlist.deactivated',
          companyId: actor.activeCompanyId,
          ...auditActor(actor),
          resourceType: 'kyc_watchlist',
          resourceId: id,
          before: { name: found.name, active: true },
          after: { active: false },
        },
        { prisma },
      );
      return updated;
    });
  }
}
