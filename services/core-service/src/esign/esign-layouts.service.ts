import { Prisma } from '@prisma/client';
import { Injectable } from '@nestjs/common';
import {
  AppError,
  AuditWriter,
  auditActor,
  Principal,
} from '@request-management/share';
import { layoutProblems, type LayoutField } from './esign-rules';
import { SaveEsignLayoutDto } from './esign.dto';
import { EsignLayoutRepository } from './esign.repositories';

interface LayoutRow {
  id: string;
  code: string;
  name: string;
  docType: string;
  fields: unknown;
  active: boolean;
  updatedAt: Date;
}

export function readFields(value: unknown): LayoutField[] {
  if (!Array.isArray(value)) return [];
  return (value as LayoutField[]).filter(
    (field) => typeof field?.key === 'string',
  );
}

/**
 * CD-165 — กำหนดช่องลงนาม: per kind of document, which parties sign, on
 * which page and where, in what order. Field keys are given in order
 * (`f1`, `f2`, …); an envelope copies the fields when it is made.
 */
@Injectable()
export class EsignLayoutsService {
  constructor(
    private readonly layouts: EsignLayoutRepository,
    private readonly audit: AuditWriter,
  ) {}

  async list(actor: Principal, includeInactive = false) {
    const rows = (await this.layouts.findMany({
      where: {
        companyId: actor.activeCompanyId,
        ...(includeInactive ? {} : { active: true }),
      },
      orderBy: [{ active: 'desc' }, { code: 'asc' }],
    })) as LayoutRow[];
    return rows.map((row) => this.present(row));
  }

  async create(dto: SaveEsignLayoutDto, actor: Principal) {
    const code = dto.code?.trim().toUpperCase();
    const name = dto.name?.trim();
    if (!code || !name) {
      throw new AppError('VALIDATION_FAILED', 'ต้องระบุรหัสและชื่อ', [
        { field: 'layout', reason: 'required' },
      ]);
    }
    const fields = this.checked(dto.fields ?? []);
    const taken = await this.layouts.findFirst({
      where: { companyId: actor.activeCompanyId, code },
      select: { id: true },
    });
    if (taken) throw new AppError('CONFLICT', `รหัส ${code} ถูกใช้แล้ว`);
    const row = (await this.layouts.create({
      data: {
        companyId: actor.activeCompanyId,
        code,
        name,
        docType: dto.doc_type ?? 'contract',
        fields: fields as unknown as Prisma.InputJsonValue,
        createdBy: actor.userId,
      },
    })) as LayoutRow;
    await this.audit.record({
      eventType: 'esign.layout.created',
      companyId: actor.activeCompanyId,
      ...auditActor(actor),
      resourceType: 'esign_layout',
      resourceId: row.id,
      after: { code, name, fields: fields.length },
    });
    return this.present(row);
  }

  async update(id: string, dto: SaveEsignLayoutDto, actor: Principal) {
    const before = await this.require(id, actor);
    const fields =
      dto.fields === undefined ? undefined : this.checked(dto.fields);
    const row = (await this.layouts.update({
      where: { id },
      data: {
        ...(dto.name?.trim() ? { name: dto.name.trim() } : {}),
        ...(dto.doc_type ? { docType: dto.doc_type } : {}),
        ...(dto.active === undefined ? {} : { active: dto.active }),
        ...(fields
          ? { fields: fields as unknown as Prisma.InputJsonValue }
          : {}),
        updatedBy: actor.userId,
      },
    })) as LayoutRow;
    await this.audit.record({
      eventType: 'esign.layout.updated',
      companyId: actor.activeCompanyId,
      ...auditActor(actor),
      resourceType: 'esign_layout',
      resourceId: id,
      before: { name: before.name, active: before.active },
      after: { name: row.name, active: row.active },
    });
    return this.present(row);
  }

  /** The layout an envelope is made from — active, in the company. */
  async usable(id: string, companyId: string) {
    const row = (await this.layouts.findFirst({
      where: { id, companyId, active: true },
    })) as LayoutRow | null;
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบแม่แบบช่องลงนาม');
    return this.present(row);
  }

  private checked(input: SaveEsignLayoutDto['fields'] = []): LayoutField[] {
    const fields: LayoutField[] = input.map((field, index) => ({
      key: `f${index + 1}`,
      label: field.label.trim(),
      page: /^[0-9]+$/.test(field.page)
        ? Number(field.page)
        : (field.page as 'first' | 'last' | 'appendix'),
      position: field.position,
      order: field.order,
    }));
    const problems = layoutProblems(fields);
    if (problems.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        problems[0],
        problems.map((reason) => ({ field: 'fields', reason })),
      );
    }
    return fields;
  }

  private async require(id: string, actor: Principal) {
    const row = (await this.layouts.findFirst({
      where: { id, companyId: actor.activeCompanyId },
    })) as LayoutRow | null;
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบแม่แบบช่องลงนาม');
    return row;
  }

  private present(row: LayoutRow) {
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      docType: row.docType,
      active: row.active,
      fields: readFields(row.fields),
      updatedAt: row.updatedAt,
    };
  }
}
