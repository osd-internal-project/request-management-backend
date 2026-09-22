import { Injectable } from '@nestjs/common';
import {
  AppError,
  AuditWriter,
  Principal,
  PrismaTransactionService,
  auditActor,
  isRunNumberDocType,
  tokensFor,
  validatePattern,
  type RunNumberDocType,
  type RunNumberReset,
  type RunNumberTokenDef,
} from '@request-management/share';
import {
  CreateRunNumberSettingDto,
  UpdateRunNumberSettingDto,
} from './dto/run-number.dto';
import { RunNumberSettingRepository } from './run-number.repository';

/** สิ่งที่ทุกคนที่เรียก service นี้อ่านกลับไป. */
export interface RunNumberSettingRow {
  id: string;
  companyId: string;
  docType: string;
  scopeKey: string;
  pattern: string;
  seqPadding: number;
  startNumber: number;
  resetPeriod: RunNumberReset;
  active: boolean;
}

@Injectable()
export class RunNumberSettingsService {
  constructor(
    private readonly settings: RunNumberSettingRepository,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
  ) {}

  async list(actor: Principal): Promise<RunNumberSettingRow[]> {
    return (await this.settings.findMany({
      where: { companyId: actor.activeCompanyId },
      orderBy: [{ docType: 'asc' }, { scopeKey: 'asc' }],
    })) as RunNumberSettingRow[];
  }

  /** ตัวแปรที่ชนิดเอกสารนี้อ้างได้ — หน้าตั้งค่าแสดงรายการนี้ ไม่ฝังเอง. */
  tokens(docType: string): readonly RunNumberTokenDef[] {
    if (!isRunNumberDocType(docType)) {
      throw new AppError('VALIDATION_FAILED', 'ไม่รู้จักชนิดเอกสารที่ระบุ', [
        { field: 'doc_type', reason: docType },
      ]);
    }

    return tokensFor(docType);
  }

  async create(
    dto: CreateRunNumberSettingDto,
    actor: Principal,
  ): Promise<RunNumberSettingRow> {
    const scopeKey = (dto.scope_key ?? '*').trim() || '*';
    const next = {
      pattern: dto.pattern.trim(),
      seqPadding: dto.seq_padding ?? 4,
      startNumber: dto.start_number ?? 1,
      resetPeriod: dto.reset_period ?? 'none',
    };

    this.assertPattern(dto.doc_type, next);

    const existing = await this.settings.findFirst({
      where: {
        companyId: actor.activeCompanyId,
        docType: dto.doc_type,
        scopeKey,
      },
      select: { id: true },
    });

    if (existing) {
      throw new AppError(
        'CONFLICT',
        'มีรูปแบบของชนิดเอกสารและขอบเขตนี้อยู่แล้ว',
        [{ field: 'scope_key', reason: scopeKey }],
      );
    }

    return this.transactions.execute(async (prisma) => {
      const row = (await this.settings.create(
        {
          data: {
            companyId: actor.activeCompanyId,
            docType: dto.doc_type,
            scopeKey,
            ...next,
            active: dto.active ?? true,
            createdBy: actor.userId,
            updatedBy: actor.userId,
          },
        },
        { prisma },
      )) as RunNumberSettingRow;

      await this.audit.record(
        {
          eventType: 'run_number.setting.created',
          companyId: actor.activeCompanyId,
          ...auditActor(actor),
          resourceType: 'run_number_setting',
          resourceId: row.id,
          after: { ...row },
        },
        { prisma },
      );

      return row;
    });
  }

  async update(
    id: string,
    dto: UpdateRunNumberSettingDto,
    actor: Principal,
  ): Promise<RunNumberSettingRow> {
    const found = await this.mine(id, actor);

    const next = {
      pattern: dto.pattern?.trim() || found.pattern,
      seqPadding: dto.seq_padding ?? found.seqPadding,
      startNumber: dto.start_number ?? found.startNumber,
      resetPeriod: dto.reset_period ?? found.resetPeriod,
    };

    this.assertPattern(found.docType, next);

    const active = dto.active ?? found.active;
    if (!active && found.active) await this.assertNotLastActive(found, actor);

    return this.transactions.execute(async (prisma) => {
      const row = (await this.settings.update(
        {
          where: { id },
          data: { ...next, active, updatedBy: actor.userId },
        },
        { prisma },
      )) as RunNumberSettingRow;

      await this.audit.record(
        {
          eventType: 'run_number.setting.updated',
          companyId: actor.activeCompanyId,
          ...auditActor(actor),
          resourceType: 'run_number_setting',
          resourceId: id,
          before: { ...found },
          after: { ...row },
        },
        { prisma },
      );

      return row;
    });
  }

  async remove(id: string, actor: Principal): Promise<void> {
    const found = await this.mine(id, actor);
    await this.assertNotLastActive(found, actor);

    await this.transactions.execute(async (prisma) => {
      await this.settings.delete({ where: { id } }, { prisma });

      await this.audit.record(
        {
          eventType: 'run_number.setting.deleted',
          companyId: actor.activeCompanyId,
          ...auditActor(actor),
          resourceType: 'run_number_setting',
          resourceId: id,
          before: { ...found },
        },
        { prisma },
      );
    });
  }

  /** แถวของบริษัทอื่นตอบ 404 ไม่ใช่ 403 — SCOPE-03 ไม่เปิดเผยว่ามีอยู่. */
  private async mine(
    id: string,
    actor: Principal,
  ): Promise<RunNumberSettingRow> {
    const row = (await this.settings.findFirst({
      where: { id, companyId: actor.activeCompanyId },
    })) as RunNumberSettingRow | null;

    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบรูปแบบเลขรันที่ระบุ');

    return row;
  }

  private assertPattern(
    docType: string,
    next: {
      pattern: string;
      seqPadding: number;
      resetPeriod: RunNumberReset;
    },
  ): void {
    if (!isRunNumberDocType(docType)) {
      throw new AppError('VALIDATION_FAILED', 'ไม่รู้จักชนิดเอกสารที่ระบุ', [
        { field: 'doc_type', reason: docType },
      ]);
    }

    const reasons = validatePattern({
      pattern: next.pattern,
      docType,
      resetPeriod: next.resetPeriod,
      seqPadding: next.seqPadding,
    });

    if (reasons.length > 0) {
      throw new AppError(
        'VALIDATION_FAILED',
        'รูปแบบเลขรันใช้ไม่ได้',
        reasons.map((reason) => ({ field: 'pattern', reason })),
      );
    }
  }

  /**
   * ปิดหรือลบแถวที่ใช้งานอยู่แถวสุดท้ายของชนิดเอกสารไม่ได้ — การออกเลขจะตกไปใช้
   * ค่าสำรองในโค้ดที่หน้าจอมองไม่เห็น.
   */
  private async assertNotLastActive(
    row: RunNumberSettingRow,
    actor: Principal,
  ): Promise<void> {
    const remaining = await this.settings.count({
      where: {
        companyId: actor.activeCompanyId,
        docType: row.docType,
        active: true,
        id: { not: row.id },
      },
    });

    if (remaining === 0) {
      throw new AppError(
        'RUN_NUMBER_SETTING_IN_USE',
        'ต้องมีรูปแบบที่ใช้งานอยู่อย่างน้อยหนึ่งรูปแบบต่อชนิดเอกสาร',
        [{ field: 'doc_type', reason: row.docType }],
      );
    }
  }
}

export type { RunNumberDocType };
