import { RequestStatus } from '@prisma/client';
import { AppError } from '@request-management/share';
import {
  assertTransition,
  canTransition,
  EDITABLE_STATUSES,
  REQUEST_TRANSITIONS,
  TERMINAL_STATUSES,
} from './request-state-machine';

describe('§7.1 request state machine', () => {
  describe('REQ-07: declared transitions', () => {
    it('walks the happy path submit → approve → complete', () => {
      expect(canTransition('draft', 'submitted')).toBe(true);
      expect(canTransition('submitted', 'pending_approval')).toBe(true);
      expect(canTransition('pending_approval', 'approved')).toBe(true);
      expect(canTransition('approved', 'in_progress')).toBe(true);
      expect(canTransition('in_progress', 'completed')).toBe(true);
    });

    it('allows the return → fix → resubmit loop', () => {
      expect(canTransition('pending_approval', 'returned')).toBe(true);
      expect(canTransition('returned', 'submitted')).toBe(true);
    });

    it('allows cancelling from every state before completed', () => {
      const cancellable: RequestStatus[] = [
        'draft',
        'submitted',
        'returned',
        'pending_approval',
        'approved',
        'in_progress',
      ];

      for (const status of cancellable) {
        expect(canTransition(status, 'cancelled')).toBe(true);
      }
    });
  });

  describe('REQ-07: transitions outside the declared paths are impossible', () => {
    it('cannot skip approval by jumping draft → approved', () => {
      expect(canTransition('draft', 'approved')).toBe(false);
    });

    it('cannot reopen a terminal request', () => {
      for (const status of TERMINAL_STATUSES) {
        expect(REQUEST_TRANSITIONS[status]).toHaveLength(0);
      }
    });

    it('cannot cancel a completed request', () => {
      expect(canTransition('completed', 'cancelled')).toBe(false);
    });

    it('throws REQ_STATE_INVALID with a 409 rather than returning false', () => {
      expect.assertions(2);

      try {
        assertTransition('completed', 'draft');
      } catch (error) {
        expect((error as AppError).code).toBe('REQ_STATE_INVALID');
        expect((error as AppError).httpStatus).toBe(409);
      }
    });
  });

  describe('REQ-01/REQ-03: editability', () => {
    it('only allows form edits before the request is anyone else’s to act on', () => {
      expect(EDITABLE_STATUSES).toEqual(['draft', 'returned']);
      expect(EDITABLE_STATUSES).not.toContain('pending_approval');
    });
  });
});
