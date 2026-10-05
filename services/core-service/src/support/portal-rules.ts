/**
 * CD-249 Customer Portal — the pure part: how long an invite and a session
 * last, whether an invite still opens the portal, and what a case raised
 * there must have.
 */

export const INVITE_DAYS = 90;
export const SESSION_HOURS = 8;
export const SEVERITIES = ['critical', 'high', 'medium', 'low'];

export function inviteExpiry(at: Date) {
  return new Date(at.getTime() + INVITE_DAYS * 86_400_000);
}

export function sessionExpiry(at: Date) {
  return new Date(at.getTime() + SESSION_HOURS * 3_600_000);
}

/** An invite opens the portal while it is neither revoked nor expired. */
export function inviteState(
  contact: {
    inviteHash: string | null;
    inviteExpires: Date | null;
    revokedAt: Date | null;
  },
  now: Date,
): 'active' | 'expired' | 'revoked' | 'none' {
  if (contact.revokedAt) return 'revoked';
  if (!contact.inviteHash || !contact.inviteExpires) return 'none';
  return contact.inviteExpires <= now ? 'expired' : 'active';
}

export interface PortalCase {
  subject: string;
  detail?: string | null;
  severity: string;
}

export function caseProblems(input: PortalCase): string[] {
  const problems: string[] = [];
  if (!input.subject.trim()) problems.push('กรุณาระบุเรื่องที่แจ้ง');
  if (input.subject.length > 255) problems.push('เรื่องยาวเกิน 255 ตัวอักษร');
  if ((input.detail ?? '').length > 4000) {
    problems.push('รายละเอียดยาวเกิน 4,000 ตัวอักษร');
  }
  if (!SEVERITIES.includes(input.severity)) {
    problems.push('ความรุนแรงต้องเป็น วิกฤต / สูง / กลาง / ต่ำ');
  }
  return problems;
}

/** What the customer may see of a case's status — the plain words only. */
export function customerStatus(status: string) {
  if (['draft', 'submitted', 'returned'].includes(status)) return 'received';
  if (['in_progress', 'pending_approval', 'approved'].includes(status)) {
    return 'working';
  }
  if (status === 'on_hold') return 'waiting';
  if (['completed', 'closed'].includes(status)) return 'done';
  return 'cancelled';
}
