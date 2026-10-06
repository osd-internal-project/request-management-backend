import { Injectable } from '@nestjs/common';
import {
  SolutionClarificationRepository,
  SolutionRepository,
  SolutionVersionRepository,
} from '../presales/solution.repositories';
import { boqProductCode } from './kb-field-rules';
import { KbCandidateRepository } from './kb.repositories';

interface AnsweredRow {
  id: string;
  companyId: string;
  solutionId: string;
  question: string;
  answer: string | null;
  answerRecordedAt: Date | null;
}

/**
 * CD-264 ความรู้จากคำถาม-คำตอบเทคนิค Pre-Sales (part of CD-22 KBMS) — every
 * technical question a customer answered on a Solution (CD-140) lands in the
 * field-knowledge inbox next to closed service jobs, grouped by the
 * Solution's first SAP item. Most answers are about one customer, so a
 * person picks the ones that hold in general (KbFieldService.draftFrom); the
 * draft carries the question and the answer only — not the customer, the
 * respondent or the deal.
 */
@Injectable()
export class KbPresalesService {
  constructor(
    private readonly clarifications: SolutionClarificationRepository,
    private readonly solutions: SolutionRepository,
    private readonly versions: SolutionVersionRepository,
    private readonly candidates: KbCandidateRepository,
  ) {}

  /** Answered questions not yet in the inbox (a company, or every company). */
  async capture(companyId?: string) {
    const answered = (await this.clarifications.findMany({
      where: {
        ...(companyId ? { companyId } : {}),
        deletedAt: null,
        answer: { not: null },
        answerRecordedAt: { not: null },
      },
      select: {
        id: true,
        companyId: true,
        solutionId: true,
        question: true,
        answer: true,
        answerRecordedAt: true,
      },
      orderBy: { answerRecordedAt: 'desc' },
      take: 1000,
    })) as AnsweredRow[];
    if (!answered.length) return 0;
    const known = (await this.candidates.findMany({
      where: {
        source: 'presales',
        sourceId: { in: answered.map((a) => a.id) },
      },
      select: { sourceId: true },
    })) as { sourceId: string }[];
    const seen = new Set(known.map((k) => k.sourceId));
    const fresh = answered.filter((a) => !seen.has(a.id) && a.answer?.trim());
    if (!fresh.length) return 0;

    const solutionIds = [...new Set(fresh.map((a) => a.solutionId))];
    const [solutions, versions] = await Promise.all([
      this.solutions.findMany({
        where: { id: { in: solutionIds } },
        select: { id: true, title: true, currentVersionNo: true },
      }) as Promise<{ id: string; title: string; currentVersionNo: number }[]>,
      this.versions.findMany({
        where: { solutionId: { in: solutionIds } },
        select: { solutionId: true, versionNo: true, boq: true },
      }) as Promise<{ solutionId: string; versionNo: number; boq: unknown }[]>,
    ]);
    let created = 0;
    for (const a of fresh) {
      const solution = solutions.find((s) => s.id === a.solutionId);
      const version = versions.find(
        (v) =>
          v.solutionId === a.solutionId &&
          v.versionNo === solution?.currentVersionNo,
      );
      const exists = await this.candidates.count({
        where: { source: 'presales', sourceId: a.id },
      });
      if (exists) continue;
      await this.candidates.create({
        data: {
          companyId: a.companyId,
          source: 'presales',
          sourceId: a.id,
          solutionId: a.solutionId,
          requestNo: solution?.title ?? null,
          title: a.question.trim(),
          cause: '',
          resolution: a.answer!.trim(),
          productCode: boqProductCode(version?.boq),
          closedAt: a.answerRecordedAt ?? new Date(),
        },
      });
      created += 1;
    }
    return created;
  }
}
