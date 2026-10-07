import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  AppError,
  PrismaTransactionService,
  formatRunNumber,
  periodKeyOf,
  unresolvedTokens,
  type RunNumberContext,
  type RunNumberDocType,
  type RunNumberFormat,
} from '@request-management/share';
import {
  RunNumberCounterRepository,
  RunNumberSettingRepository,
} from './run-number.repository';

/**
 * รูปแบบสำรองเมื่อบริษัทยังไม่มีแถวของชนิดเอกสารนั้น.
 * ถ้าถูกใช้จริง แปลว่ามีบริษัทที่ migration seed ตกหล่น.
 */
const FALLBACK: Readonly<Record<RunNumberDocType, RunNumberFormat>> = {
  REQUEST: {
    pattern: 'REQ-{COMPANY_PREFIX}-{TYPE}-{YYMM}{SEQ}',
    seqPadding: 4,
    startNumber: 1,
    resetPeriod: 'monthly',
  },
  CUSTOMER: {
    pattern: 'CUS-{COMPANY_PREFIX}-{SEQ}',
    seqPadding: 6,
    startNumber: 1,
    resetPeriod: 'none',
  },
  OPPORTUNITY: {
    pattern: 'OPP-{COMPANY_PREFIX}-{SEQ}',
    seqPadding: 6,
    startNumber: 1,
    resetPeriod: 'none',
  },
  SALE_ORDER: {
    pattern: 'SO-{COMPANY_PREFIX}-{SEQ}',
    seqPadding: 6,
    startNumber: 1,
    resetPeriod: 'none',
  },
  QUOTATION: {
    pattern: 'QT-{COMPANY_PREFIX}-{SEQ}',
    seqPadding: 6,
    startNumber: 1,
    resetPeriod: 'none',
  },
  PROJECT: {
    pattern: 'PRJ-{COMPANY_PREFIX}-{SEQ}',
    seqPadding: 6,
    startNumber: 1,
    resetPeriod: 'none',
  },
  ADVANCE: {
    pattern: 'ADV-{COMPANY_PREFIX}-{YYYY}-{SEQ}',
    seqPadding: 5,
    startNumber: 1,
    resetPeriod: 'yearly',
  },
  PETTY_CASH: {
    pattern: 'PC-{COMPANY_PREFIX}-{YYYY}-{SEQ}',
    seqPadding: 5,
    startNumber: 1,
    resetPeriod: 'yearly',
  },
  PETTY_REPLENISH: {
    pattern: 'PCR-{COMPANY_PREFIX}-{YYYY}-{SEQ}',
    seqPadding: 5,
    startNumber: 1,
    resetPeriod: 'yearly',
  },
};

export interface IssueResult {
  readonly number: string;
  readonly seq: number;
  readonly pattern: string;
  readonly periodKey: string;
}

/**
 * REQ-02 / CM-02 — ออกเลขรัน และเป็นที่เดียวที่ `run_number_counters` ถูกบวก.
 * ลำดับบวกด้วย statement เดียวเพื่อกันเลขซ้ำ (NFR-03) — docs/run-number.md.
 */
@Injectable()
export class RunNumberService {
  constructor(
    private readonly settings: RunNumberSettingRepository,
    private readonly counters: RunNumberCounterRepository,
    private readonly transactions: PrismaTransactionService,
  ) {}

  /**
   * จองเลขถัดไป — หนึ่งคำขอได้หนึ่งเลข และกินลำดับไปหนึ่งเสมอ.
   * การวนหาเลขที่ยังว่างอยู่ฝั่งผู้เรียก ซึ่งเป็นที่ที่ตารางเอกสารอยู่ (§03).
   */
  async issue(ctx: RunNumberContext): Promise<IssueResult> {
    const setting = await this.resolve(
      ctx.docType,
      ctx.companyId,
      ctx.scopeKey,
    );

    const missing = unresolvedTokens(setting.pattern, ctx);
    if (missing.length > 0) {
      throw new AppError(
        'VALIDATION_FAILED',
        'ข้อมูลไม่พอสำหรับออกเลขตามรูปแบบที่ตั้งไว้',
        missing.map((token) => ({ field: 'master', reason: token })),
      );
    }

    const periodKey = periodKeyOf(setting.resetPeriod, ctx.at);

    return this.transactions.execute(async (prisma) => {
      const seq = await this.nextSequence(prisma, ctx, periodKey, setting);

      return {
        number: formatRunNumber(setting, ctx, seq),
        seq,
        pattern: setting.pattern,
        periodKey,
      };
    });
  }

  /**
   * เลขที่จะออกครั้งถัดไป โดยไม่แตะ counter.
   * `override` คือรูปแบบที่หน้าตั้งค่ายังไม่บันทึก.
   */
  async preview(
    ctx: RunNumberContext,
    override?: RunNumberFormat,
  ): Promise<IssueResult> {
    const setting =
      override ??
      (await this.resolve(ctx.docType, ctx.companyId, ctx.scopeKey));
    const periodKey = periodKeyOf(setting.resetPeriod, ctx.at);
    const seq = await this.peekSequence(ctx, periodKey, setting);

    return {
      number: formatRunNumber(setting, ctx, seq),
      seq,
      pattern: setting.pattern,
      periodKey,
    };
  }

  /**
   * รูปแบบที่ใช้กับ context นี้: ของ scope นั้นก่อน แล้วค่อยของทั้งชนิด แล้วค่อย
   * ค่าสำรองในโค้ด. แถวที่ปิดการใช้งานไว้ถูกข้าม เหมือนไม่มีแถวนั้น.
   */
  private async resolve(
    docType: RunNumberDocType,
    companyId: string,
    scopeKey: string,
  ): Promise<RunNumberFormat> {
    const rows = (await this.settings.findMany({
      where: {
        companyId,
        docType,
        active: true,
        scopeKey: scopeKey === '*' ? '*' : { in: [scopeKey, '*'] },
      },
    })) as (RunNumberFormat & { scopeKey: string })[];

    const exact = rows.find((row) => row.scopeKey === scopeKey);
    const fallback = rows.find((row) => row.scopeKey === '*');

    return exact ?? fallback ?? FALLBACK[docType];
  }

  /**
   * statement เดียว: สร้างแถวของช่วงนี้หรือบวกมัน แล้วคืนค่าที่ผู้เรียกเป็นเจ้าของ.
   * สองคำขอพร้อมกันได้ 1 กับ 2 ไม่ใช่ 1 กับ 1. แถวแรกเริ่มที่ `startNumber`.
   */
  private async nextSequence(
    prisma: Prisma.TransactionClient,
    ctx: RunNumberContext,
    periodKey: string,
    setting: RunNumberFormat,
  ): Promise<number> {
    const rows = await prisma.$queryRaw<{ lastSeq: number }[]>`
      INSERT INTO run_number_counters
        (id, "companyId", "docType", "scopeKey", "periodKey", "lastSeq", "updatedAt")
      VALUES
        (gen_random_uuid(), ${ctx.companyId}, ${ctx.docType}, ${ctx.scopeKey},
         ${periodKey}, ${setting.startNumber}, now())
      ON CONFLICT ("companyId", "docType", "scopeKey", "periodKey")
      DO UPDATE SET
        "lastSeq" = run_number_counters."lastSeq" + 1,
        "updatedAt" = now()
      RETURNING "lastSeq"
    `;

    return rows[0].lastSeq;
  }

  /** ลำดับที่จะได้ถ้าออกเลขเดี๋ยวนี้ — อ่านเท่านั้น ไม่บวก. */
  private async peekSequence(
    ctx: RunNumberContext,
    periodKey: string,
    setting: RunNumberFormat,
  ): Promise<number> {
    const counter = (await this.counters.findFirst({
      where: {
        companyId: ctx.companyId,
        docType: ctx.docType,
        scopeKey: ctx.scopeKey,
        periodKey,
      },
      select: { lastSeq: true },
    })) as { lastSeq: number } | null;

    return counter ? counter.lastSeq + 1 : setting.startNumber;
  }
}
