/**
 * CD-271 — the content calendar's rules: the channels, the moves between
 * states, and when the owner is reminded. Pure.
 */

export const CONTENT_CHANNELS = [
  'line_oa',
  'facebook',
  'tiktok',
  'instagram',
  'website',
  'email',
] as const;
export type ContentChannel = (typeof CONTENT_CHANNELS)[number];

export const CONTENT_STATUSES = [
  'draft',
  'pending_approval',
  'ready',
  'published',
  'cancelled',
] as const;
export type ContentStatus = (typeof CONTENT_STATUSES)[number];

/**
 * Moves allowed by hand. `pending_approval` is entered and left only by the
 * approval (CD-272): sent for approval, then approved → ready, or rejected /
 * withdrawn → draft.
 */
const MOVES: Record<ContentStatus, readonly ContentStatus[]> = {
  draft: ['ready', 'cancelled'],
  pending_approval: [],
  ready: ['draft', 'published', 'cancelled'],
  published: [],
  cancelled: ['draft'],
};

export function canMove(from: string, to: string): boolean {
  return (MOVES[from as ContentStatus] ?? []).includes(to as ContentStatus);
}

/** Text and files change only before it goes out. */
export function editable(status: string): boolean {
  return status === 'draft' || status === 'ready';
}

const HOUR = 3_600_000;

/** The owner hears the day before a ready post is due — once. */
export function remindNow(input: {
  status: string;
  plannedAt: Date;
  remindedAt: Date | null;
  now: Date;
}): boolean {
  const left = input.plannedAt.getTime() - input.now.getTime();
  return (
    input.status === 'ready' &&
    input.remindedAt === null &&
    left > 0 &&
    left <= 24 * HOUR
  );
}

/** An hour past its time and not marked published — the owner hears, once. */
export function overdueNow(input: {
  status: string;
  plannedAt: Date;
  overdueAt: Date | null;
  now: Date;
}): boolean {
  return (
    (input.status === 'ready' || input.status === 'draft') &&
    input.overdueAt === null &&
    input.now.getTime() - input.plannedAt.getTime() > HOUR
  );
}

export function publishProblems(url: string | undefined): string[] {
  const link = (url ?? '').trim();
  if (!link) return ['ใส่ลิงก์โพสต์จริง'];
  if (!/^https?:\/\//i.test(link))
    return ['ลิงก์ต้องขึ้นต้นด้วย http:// หรือ https://'];
  return [];
}

// --- CD-272 อนุมัติสื่อและเนื้อหา ------------------------------------------------

export interface ApprovalFacts {
  mentionsCustomer: boolean;
  mentionsPrice: boolean;
  mentionsPartner: boolean;
  approvalStatus: string;
  approvedVersion: number | null;
  version: number;
}

/** Content that names a customer, a price or a partner — or all, if the company says so. */
export function needsApproval(item: ApprovalFacts, all: boolean): boolean {
  return (
    all || item.mentionsCustomer || item.mentionsPrice || item.mentionsPartner
  );
}

/** Approved, and for the words as they are now. */
export function approvedNow(item: ApprovalFacts): boolean {
  return (
    item.approvalStatus === 'approved' && item.approvedVersion === item.version
  );
}

/** Why it may not be Ready yet; null when it may. */
export function readyBlocker(item: ApprovalFacts, all: boolean): string | null {
  return needsApproval(item, all) && !approvedNow(item)
    ? 'คอนเทนต์นี้ต้องผ่านการอนุมัติก่อน — กด "ส่งอนุมัติ"'
    : null;
}
