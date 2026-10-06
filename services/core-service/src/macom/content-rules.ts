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
  'ready',
  'published',
  'cancelled',
] as const;
export type ContentStatus = (typeof CONTENT_STATUSES)[number];

/** Moves allowed by hand. CD-272 adds the approval step between draft and ready. */
const MOVES: Record<ContentStatus, readonly ContentStatus[]> = {
  draft: ['ready', 'cancelled'],
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
