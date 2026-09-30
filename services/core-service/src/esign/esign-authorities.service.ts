import { Injectable } from '@nestjs/common';
import {
  AppError,
  AuditWriter,
  auditActor,
  Principal,
} from '@request-management/share';
import { CompanyMemberRepository } from '../access/company-member.repository';
import { authorityFor, type AuthorityEntry } from './esign-rules';
import { SaveEsignAuthorityDto } from './esign.dto';
import { EsignAuthorityRepository } from './esign.repositories';

interface AuthorityRow {
  id: string;
  companyId: string;
  userId: string;
  title: string;
  limitAmount: { toString(): string } | null;
  docTypes: string[];
  validFrom: Date | null;
  validTo: Date | null;
  active: boolean;
  note: string | null;
  updatedAt: Date;
}

const asDay = (value: string | null | undefined) =>
  value ? new Date(`${value.slice(0, 10)}T00:00:00Z`) : null;
const day = (value: Date | null) =>
  value ? value.toISOString().slice(0, 10) : null;

const entryOf = (row: AuthorityRow): AuthorityEntry => ({
  userId: row.userId,
  title: row.title,
  limitAmount:
    row.limitAmount === null ? null : Number(row.limitAmount.toString()),
  docTypes: row.docTypes,
  validFrom: row.validFrom,
  validTo: row.validTo,
  active: row.active,
});

/**
 * CD-172 ตรวจอำนาจลงนาม — the company's register of who may sign for it,
 * by amount and kind of document, and the check an envelope runs against
 * it (when made, and again when the signer opens or signs — a register
 * changed in between counts).
 */
@Injectable()
export class EsignAuthoritiesService {
  constructor(
    private readonly authorities: EsignAuthorityRepository,
    private readonly members: CompanyMemberRepository,
    private readonly audit: AuditWriter,
  ) {}

  async list(actor: Principal) {
    const rows = (await this.authorities.findMany({
      where: { companyId: actor.activeCompanyId },
      orderBy: [{ active: 'desc' }, { title: 'asc' }],
    })) as AuthorityRow[];
    const names = await this.names(rows.map((row) => row.userId));
    return rows.map((row) => this.present(row, names));
  }

  async create(dto: SaveEsignAuthorityDto, actor: Principal) {
    const title = dto.title?.trim();
    if (!dto.user_id || !title) {
      throw new AppError('VALIDATION_FAILED', 'ต้องระบุผู้มีอำนาจและตำแหน่ง', [
        { field: 'authority', reason: 'required' },
      ]);
    }
    await this.assertMember(actor.activeCompanyId, dto.user_id);
    this.assertPeriod(dto.valid_from, dto.valid_to);
    const row = (await this.authorities.create({
      data: {
        companyId: actor.activeCompanyId,
        userId: dto.user_id,
        title,
        limitAmount: dto.limit_amount ?? null,
        docTypes: dto.doc_types ?? [],
        validFrom: asDay(dto.valid_from),
        validTo: asDay(dto.valid_to),
        note: dto.note?.trim() || null,
        createdBy: actor.userId,
      },
    })) as AuthorityRow;
    await this.audit.record({
      eventType: 'esign.authority.created',
      companyId: actor.activeCompanyId,
      ...auditActor(actor),
      resourceType: 'esign_authority',
      resourceId: row.id,
      after: {
        userId: dto.user_id,
        title,
        limitAmount: dto.limit_amount ?? null,
        docTypes: dto.doc_types ?? [],
      },
    });
    return this.present(row, await this.names([row.userId]));
  }

  async update(id: string, dto: SaveEsignAuthorityDto, actor: Principal) {
    const before = (await this.authorities.findFirst({
      where: { id, companyId: actor.activeCompanyId },
    })) as AuthorityRow | null;
    if (!before) throw new AppError('NOT_FOUND', 'ไม่พบรายการในทะเบียน');
    this.assertPeriod(
      dto.valid_from === undefined ? day(before.validFrom) : dto.valid_from,
      dto.valid_to === undefined ? day(before.validTo) : dto.valid_to,
    );
    const row = (await this.authorities.update({
      where: { id },
      data: {
        ...(dto.title?.trim() ? { title: dto.title.trim() } : {}),
        ...(dto.limit_amount === undefined
          ? {}
          : { limitAmount: dto.limit_amount }),
        ...(dto.doc_types === undefined ? {} : { docTypes: dto.doc_types }),
        ...(dto.valid_from === undefined
          ? {}
          : { validFrom: asDay(dto.valid_from) }),
        ...(dto.valid_to === undefined ? {} : { validTo: asDay(dto.valid_to) }),
        ...(dto.active === undefined ? {} : { active: dto.active }),
        ...(dto.note === undefined ? {} : { note: dto.note?.trim() || null }),
        updatedBy: actor.userId,
      },
    })) as AuthorityRow;
    await this.audit.record({
      eventType: 'esign.authority.updated',
      companyId: actor.activeCompanyId,
      ...auditActor(actor),
      resourceType: 'esign_authority',
      resourceId: id,
      before: { ...entryOf(before) },
      after: { ...entryOf(row) },
    });
    return this.present(row, await this.names([row.userId]));
  }

  /** The check: may `userId` sign this kind of document of this amount? */
  async check(
    companyId: string,
    userId: string,
    docType: string,
    amount: number | null,
    today = new Date(),
  ) {
    const rows = (await this.authorities.findMany({
      where: { companyId, userId },
    })) as AuthorityRow[];
    return authorityFor(rows.map(entryOf), userId, docType, amount, today);
  }

  private assertPeriod(from?: string | null, to?: string | null) {
    if (from && to && from.slice(0, 10) > to.slice(0, 10)) {
      throw new AppError('VALIDATION_FAILED', 'วันเริ่มต้องไม่หลังวันสิ้นสุด', [
        { field: 'valid_to', reason: 'before_from' },
      ]);
    }
  }

  private async assertMember(companyId: string, userId: string) {
    const member = await this.members.findFirst({
      where: {
        id: userId,
        status: 'ACTIVE',
        companies: { some: { companyId } },
      },
      select: { id: true },
    });
    if (!member) {
      throw new AppError(
        'VALIDATION_FAILED',
        'ต้องเป็นผู้ใช้ที่ยังทำงานในบริษัทนี้',
        [{ field: 'user_id', reason: userId }],
      );
    }
  }

  private async names(ids: string[]) {
    const unique = [...new Set(ids)];
    if (!unique.length) return new Map<string, string>();
    const users = (await this.members.findMany({
      where: { id: { in: unique } },
      select: { id: true, displayName: true },
    })) as { id: string; displayName: string }[];
    return new Map(users.map((user) => [user.id, user.displayName]));
  }

  private present(row: AuthorityRow, names: Map<string, string>) {
    return {
      id: row.id,
      userId: row.userId,
      name: names.get(row.userId) ?? row.userId,
      title: row.title,
      limitAmount:
        row.limitAmount === null ? null : Number(row.limitAmount.toString()),
      docTypes: row.docTypes,
      validFrom: day(row.validFrom),
      validTo: day(row.validTo),
      active: row.active,
      note: row.note,
      updatedAt: row.updatedAt,
    };
  }
}
