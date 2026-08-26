import { RequestStatus } from '@prisma/client';
import { AppError } from '@request-management/share';
import {
  assertTransition,
  canTransition,
  CLOCK_PAUSED_IN,
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
        'on_hold',
      ];

      for (const status of cancellable) {
        expect(canTransition(status, 'cancelled')).toBe(true);
      }
    });

    it('allows the hold → resume loop only around in_progress (§7.1 amendment)', () => {
      expect(canTransition('in_progress', 'on_hold')).toBe(true);
      expect(canTransition('on_hold', 'in_progress')).toBe(true);
    });
  });

  describe('REQ-07: transitions outside the declared paths are impossible', () => {
    it('cannot skip approval by jumping draft → approved', () => {
      expect(canTransition('draft', 'approved')).toBe(false);
    });

    it('cannot hold a request that is not being worked on', () => {
      const notHoldable: RequestStatus[] = [
        'draft',
        'submitted',
        'returned',
        'pending_approval',
        'approved',
      ];

      for (const status of notHoldable) {
        expect(canTransition(status, 'on_hold')).toBe(false);
      }
    });

    it('cannot complete straight from on_hold — resume first', () => {
      expect(canTransition('on_hold', 'completed')).toBe(false);
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
      expect(EDITABLE_STATUSES).not.toContain('on_hold');
    });
  });

  describe('SUP-01: clock pauses', () => {
    it('pauses while waiting on the requester or an external factor', () => {
      expect(CLOCK_PAUSED_IN).toContain('returned');
      expect(CLOCK_PAUSED_IN).toContain('on_hold');
      expect(CLOCK_PAUSED_IN).not.toContain('in_progress');
      expect(CLOCK_PAUSED_IN).not.toContain('pending_approval');
    });
  });
});
