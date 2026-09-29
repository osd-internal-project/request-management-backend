/**
 * CD-84 — the handover checklist: what the salesperson ticks before a won
 * deal goes to the next team. Pure, so the rule "incomplete cannot be sent"
 * is tested on its own.
 */
export type HandoverCategory = 'commercial' | 'requirement' | 'commitment';

export const HANDOVER_CATEGORIES: readonly HandoverCategory[] = [
  'commercial',
  'requirement',
  'commitment',
];

export const HANDOVER_CATEGORY_LABELS: Record<HandoverCategory, string> = {
  commercial: 'ข้อมูลการค้า',
  requirement: 'ความต้องการลูกค้า',
  commitment: 'สิ่งที่รับปากไว้',
};

/** One line of the company's list (CRM settings). */
export interface ChecklistTemplateItem {
  code: string;
  category: HandoverCategory;
  label: string;
  requiresDetail: boolean;
}

/** What the salesperson sent for one line. */
export interface ChecklistAnswer {
  code: string;
  checked?: boolean;
  detail?: string | null;
}

/** A line as the handover keeps it — the list as it stood, plus the answer. */
export interface HandoverItem extends ChecklistTemplateItem {
  checked: boolean;
  detail: string | null;
}

/**
 * The checklist for a handover still being filled in: the company's current
 * list, in its order, with whatever was answered before. An answer to a line
 * the list no longer has is dropped — nobody is asked for it any more — and
 * a line added since starts unticked.
 */
export function mergeChecklist(
  template: readonly ChecklistTemplateItem[],
  answers: readonly ChecklistAnswer[],
): HandoverItem[] {
  const byCode = new Map(answers.map((answer) => [answer.code, answer]));
  return template.map((item) => {
    const answer = byCode.get(item.code);
    return {
      code: item.code,
      category: item.category,
      label: item.label,
      requiresDetail: item.requiresDetail,
      checked: answer?.checked === true,
      detail: answer?.detail?.trim() || null,
    };
  });
}

/**
 * Why this checklist cannot be sent — every gap, named, so the salesperson
 * fixes them in one pass. Empty = complete.
 */
export function checklistGaps(items: readonly HandoverItem[]): string[] {
  const gaps: string[] = [];
  for (const item of items) {
    if (!item.checked) {
      gaps.push(`ยังไม่ได้ยืนยัน: ${item.label}`);
    } else if (item.requiresDetail && !item.detail) {
      gaps.push(`ต้องกรอกรายละเอียด: ${item.label}`);
    }
  }
  return gaps;
}

/** One entry of the handover's own history, shown to both sides. */
export interface HandoverHistoryEntry {
  action: 'submitted' | 'accepted' | 'returned';
  at: string;
  by: string;
  byName: string;
  round: number;
  reason: string | null;
}
