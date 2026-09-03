import { RequestStatus } from '@prisma/client';
import { AppError } from '@request-management/share';
import {
  assertTransition,
  canTransition,
  CARRIER_QUEUE_STATUSES,
  CLOCK_PAUSED_IN,
  EDITABLE_STATUSES,
  OPEN_STATUSES,
  REQUEST_TRANSITIONS,
  TERMINAL_STATUSES,
} from './request-state-machine';

describe('request lifecycle (ticket model)', () => {
  describe('REQ-07: declared transitions', () => {
    it('walks a request with no approval step: submit → receive → complete → close', () => {
      expect(canTransition('draft', 'submitted')).toBe(true);
      expect(canTransition('submitted', 'in_progress')).toBe(true);
      expect(canTransition('in_progress', 'completed')).toBe(true);
      // No matrix for the type — the result stands as delivered.
      expect(canTransition('completed', 'approved')).toBe(true);
      expect(canTransition('approved', 'closed')).toBe(true);
    });

    it('walks a request whose type is checked before closing', () => {
      expect(canTransition('completed', 'pending_approval')).toBe(true);
      expect(canTransition('pending_approval', 'approved')).toBe(true);
      expect(canTransition('approved', 'closed')).toBe(true);
    });

    it('sends a failed check back to the team that did the work', () => {
      expect(canTransition('pending_approval', 'in_progress')).toBe(true);
    });

    it('allows the return → fix → resubmit loop', () => {
      expect(canTransition('in_progress', 'returned')).toBe(true);
      expect(canTransition('returned', 'submitted')).toBe(true);
    });

    it('allows the hold → resume loop only around in_progress', () => {
      expect(canTransition('in_progress', 'on_hold')).toBe(true);
      expect(canTransition('on_hold', 'in_progress')).toBe(true);
    });

    it('allows cancelling from every state before the work is delivered', () => {
      const cancellable: RequestStatus[] = [
        'draft',
        'submitted',
        'returned',
        'in_progress',
        'on_hold',
        'pending_approval',
        'approved',
      ];

      for (const status of cancellable) {
        expect(canTransition(status, 'cancelled')).toBe(true);
      }
    });
  });

  describe('REQ-07: transitions outside the declared paths are impossible', () => {
    /**
     * Approval is reachable from exactly two places, and no others.
     *
     * `draft` and `returned` are the pre-work check — permission to ask, added
     * 1 ก.ย. 2569 for a type that publishes a `request:<CODE>:pre` ladder.
     * `completed` is the check on the result. Everything in between is work in
     * progress: a ticket somebody is holding cannot jump into a queue.
     */
    it('is reachable only from a submit or a completion', () => {
      const mayEnter: RequestStatus[] = ['draft', 'returned', 'completed'];
      const mayNot: RequestStatus[] = ['submitted', 'in_progress', 'on_hold'];

      for (const status of mayEnter) {
        expect(canTransition(status, 'pending_approval')).toBe(true);
      }

      for (const status of mayNot) {
        expect(canTransition(status, 'pending_approval')).toBe(false);
      }
    });

    /**
     * The two stages leave `pending_approval` differently, and both ways out
     * have to exist in the table for either to work.
     *
     * Pre-work: approved hands the ticket to its receiver (`submitted`), sent
     * back returns it to the requester (`returned`) — nobody has worked on it.
     * After the work: approved accepts the result, sent back goes to the team
     * that produced it (`in_progress`).
     */
    it('leaves approval by whichever door its stage uses', () => {
      for (const status of [
        'submitted',
        'returned',
        'approved',
        'in_progress',
        'rejected',
      ] as RequestStatus[]) {
        expect(canTransition('pending_approval', status)).toBe(true);
      }
    });

    it('cannot skip the receiver: submitted does not reach completed', () => {
      expect(canTransition('submitted', 'completed')).toBe(false);
    });

    it('cannot close work the requester has not accepted', () => {
      const notClosable: RequestStatus[] = [
        'draft',
        'submitted',
        'returned',
        'in_progress',
        'on_hold',
        'completed',
        'pending_approval',
      ];

      for (const status of notClosable) {
        expect(canTransition(status, 'closed')).toBe(false);
      }
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

    it('cannot cancel once the ticket is closed', () => {
      expect(canTransition('closed', 'cancelled')).toBe(false);
    });

    it('cannot reopen a terminal request', () => {
      for (const status of TERMINAL_STATUSES) {
        expect(REQUEST_TRANSITIONS[status]).toHaveLength(0);
      }
    });

    it('throws REQ_STATE_INVALID with a 409 rather than returning false', () => {
      expect.assertions(2);

      try {
        assertTransition('closed', 'draft');
      } catch (error) {
        expect((error as AppError).code).toBe('REQ_STATE_INVALID');
        expect((error as AppError).httpStatus).toBe(409);
      }
    });
  });

  describe('REQ-01/REQ-03: editability', () => {
    it('only allows form edits before the request is anyone else’s to act on', () => {
      expect(EDITABLE_STATUSES).toEqual(['draft', 'returned']);
      expect(EDITABLE_STATUSES).not.toContain('in_progress');
      expect(EDITABLE_STATUSES).not.toContain('closed');
    });
  });

  describe('SUP-01: clock pauses', () => {
    it('pauses while waiting on the requester or an external factor', () => {
      expect(CLOCK_PAUSED_IN).toContain('returned');
      expect(CLOCK_PAUSED_IN).toContain('on_hold');
    });

    /**
     * The source is explicit that RECEIVED starts the real working clock, so a
     * ticket nobody has picked up yet must not be counted against the team.
     */
    it('pauses while nobody has accepted the ticket', () => {
      expect(CLOCK_PAUSED_IN).toContain('submitted');
      expect(CLOCK_PAUSED_IN).not.toContain('in_progress');
      expect(CLOCK_PAUSED_IN).not.toContain('pending_approval');
    });
  });

  describe('a parent waits for its children', () => {
    it('counts every status where work is still somebody’s to finish', () => {
      for (const status of OPEN_STATUSES) {
        expect(TERMINAL_STATUSES).not.toContain(status);
      }
    });

    it('treats only closed, rejected and cancelled as finished', () => {
      const finished: RequestStatus[] = ['closed', 'rejected', 'cancelled'];

      for (const status of finished) {
        expect(OPEN_STATUSES).not.toContain(status);
      }
    });
  });

  /**
   * The "รับเรื่อง" tab of §16 หน้าที่ 2 used to filter
   * `submitted | in_progress | on_hold`, which took a ticket off its carrier's
   * queue the moment they sent the result for approval or the requester
   * returned it — leaving `uat.chavisat` reading `0` on work they were in the
   * middle of.
   */
  describe('the carrier’s queue', () => {
    it('keeps a ticket while it is waiting on approval or has been returned', () => {
      expect(CARRIER_QUEUE_STATUSES).toContain('pending_approval');
      expect(CARRIER_QUEUE_STATUSES).toContain('returned');
    });

    it('drops a draft, which has not been handed to anybody yet', () => {
      expect(CARRIER_QUEUE_STATUSES).not.toContain('draft');
    });

    it('drops every finished status', () => {
      for (const status of TERMINAL_STATUSES) {
        expect(CARRIER_QUEUE_STATUSES).not.toContain(status);
      }
    });
  });
});
