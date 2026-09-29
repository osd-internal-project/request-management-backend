import { Prisma } from '@prisma/client';
import { Injectable } from '@nestjs/common';
import {
  AppError,
  AuditWriter,
  auditActor,
  BaseRepository,
  Principal,
  PrismaService,
  type TQueryClient,
} from '@request-management/share';
import {
  DRAFT_VARIABLES,
  readClauses,
  templateProblems,
  type Clause,
} from './contract-drafts';
import { SaveContractTemplateDto } from './dto/legal-contract.dto';

/** CD-146 แม่แบบสัญญา. */
@Injectable()
export class ContractTemplateRepository extends BaseRepository<
  PrismaService['contractTemplate']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.contractTemplate;
  }
}

interface TemplateRow {
  id: string;
  companyId: string;
  code: string;
  name: string;
  kind: string;
  clauses: unknown;
  active: boolean;
  updatedAt: Date;
}

/**
 * CD-146 — แม่แบบสัญญา: Legal keeps the company's templates as numbered
 * clauses with `{{variables}}`. Saving checks every clause and every
 * variable; clause keys are given in order (`c1`, `c2`, …) — a draft copies
 * the clauses when it starts, so a later edit never reaches it.
 */
@Injectable()
export class ContractTemplatesService {
  constructor(
    private readonly templates: ContractTemplateRepository,
    private readonly audit: AuditWriter,
  ) {}

  /** The variables a template may use, for the editor. */
  variables() {
    return {
      variables: Object.entries(DRAFT_VARIABLES).map(([name, label]) => ({
        name,
        label,
      })),
      termPattern: 'term_<รหัสเงื่อนไขการค้า>',
    };
  }

  async list(actor: Principal, includeInactive = false) {
    const rows = (await this.templates.findMany({
      where: {
        companyId: actor.activeCompanyId,
        ...(includeInactive ? {} : { active: true }),
      },
      orderBy: [{ active: 'desc' }, { code: 'asc' }],
    })) as TemplateRow[];
    return rows.map((row) => this.present(row));
  }

  async create(dto: SaveContractTemplateDto, actor: Principal) {
    const code = dto.code?.trim().toUpperCase();
    const name = dto.name?.trim();
    if (!code || !name) {
      throw new AppError('VALIDATION_FAILED', 'ต้องระบุรหัสและชื่อแม่แบบ', [
        { field: 'template', reason: 'required' },
      ]);
    }
    const clauses = this.checked(dto.clauses ?? []);
    const taken = await this.templates.findFirst({
      where: { companyId: actor.activeCompanyId, code },
      select: { id: true },
    });
    if (taken) throw new AppError('CONFLICT', `รหัสแม่แบบ ${code} ถูกใช้แล้ว`);
    const row = (await this.templates.create({
      data: {
        companyId: actor.activeCompanyId,
        code,
        name,
        kind: dto.kind ?? 'standard',
        clauses: clauses as unknown as Prisma.InputJsonValue,
        createdBy: actor.userId,
      },
    })) as TemplateRow;
    await this.audit.record({
      eventType: 'legal.template.created',
      companyId: actor.activeCompanyId,
      ...auditActor(actor),
      resourceType: 'contract_template',
      resourceId: row.id,
      after: { code, name, clauses: clauses.length },
    });
    return this.present(row);
  }

  async update(id: string, dto: SaveContractTemplateDto, actor: Principal) {
    const before = await this.require(id, actor);
    const clauses =
      dto.clauses === undefined ? undefined : this.checked(dto.clauses);
    const row = (await this.templates.update({
      where: { id },
      data: {
        ...(dto.name?.trim() ? { name: dto.name.trim() } : {}),
        ...(dto.kind ? { kind: dto.kind } : {}),
        ...(dto.active === undefined ? {} : { active: dto.active }),
        ...(clauses
          ? { clauses: clauses as unknown as Prisma.InputJsonValue }
          : {}),
        updatedBy: actor.userId,
      },
    })) as TemplateRow;
    await this.audit.record({
      eventType: 'legal.template.updated',
      companyId: actor.activeCompanyId,
      ...auditActor(actor),
      resourceType: 'contract_template',
      resourceId: id,
      before: {
        name: before.name,
        active: before.active,
        clauses: readClauses(before.clauses).length,
      },
      after: {
        name: row.name,
        active: row.active,
        clauses: readClauses(row.clauses).length,
      },
    });
    return this.present(row);
  }

  /** The template a draft starts from — active, in the actor's company. */
  async usable(id: string, actor: Principal) {
    const row = await this.require(id, actor);
    if (!row.active) {
      throw new AppError('CONFLICT', 'แม่แบบนี้ปิดใช้แล้ว');
    }
    return { ...row, clauses: readClauses(row.clauses) };
  }

  private checked(input: { heading?: string; body?: string }[]): Clause[] {
    const clauses = input.map((clause, index) => ({
      key: `c${index + 1}`,
      heading: clause.heading?.trim() ?? '',
      body: clause.body?.trim() ?? '',
    }));
    const problems = templateProblems(clauses);
    if (problems.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        problems[0],
        problems.map((reason) => ({ field: 'clauses', reason })),
      );
    }
    return clauses;
  }

  private async require(id: string, actor: Principal) {
    const row = (await this.templates.findFirst({
      where: { id, companyId: actor.activeCompanyId },
    })) as TemplateRow | null;
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบแม่แบบสัญญา');
    return row;
  }

  private present(row: TemplateRow) {
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      kind: row.kind,
      active: row.active,
      clauses: readClauses(row.clauses),
      updatedAt: row.updatedAt,
    };
  }
}
