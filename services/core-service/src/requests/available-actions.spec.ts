import { RequestStatus } from '@prisma/client';
import type { Principal } from '@request-management/share';
import {
  ACTIONS,
  availableActions,
  hasAuthority,
  toRequestAction,
  type ActionableRequest,
} from './available-actions';
import {
  REQUEST_TRANSITIONS,
  TERMINAL_STATUSES,
} from './request-state-machine';

const REQUESTER = 'user-requester';
const RECEIVER = 'user-receiver';
const ASSIGNEE = 'user-assignee';
const HEAD = 'user-head';
const STRANGER = 'user-stranger';
const DEPT = 'unit-dept';

function request(
  overrides: Partial<ActionableRequest> = {},
): ActionableRequest {
  return {
    status: 'in_progress',
    requesterId: REQUESTER,
    receiverUserId: RECEIVER,
    assigneeUserId: ASSIGNEE,
    requesterOrgUnitId: DEPT,
    receiverOrgUnitId: null,
    ...overrides,
  };
}

type Actor = Pick<
  Principal,
  'userId' | 'ledUnitIds' | 'scopedActUnitIds' | 'scopedActUserIds'
>;

function actor(userId: string, overrides: Partial<Actor> = {}): Actor {
  return {
    userId,
    ledUnitIds: [],
    scopedActUnitIds: [],
    scopedActUserIds: [],
    ...overrides,
  };
}

const head = actor(HEAD, { ledUnitIds: [DEPT] });

function names(list: { action: string }[]): string[] {
  return list.map((entry) => entry.action);
}

/**
 * The test this file exists for.
 *
 * `ACTIONS` names a landing status for each operation, and the state machine
 * names which statuses may follow which. Two tables describing one flow drift
 * the moment somebody edits one of them — so the drift is what is asserted
 * against, on every row, rather than on the handful the use case walks.
 */
describe('the action table cannot drift from the state machine', () => {
  it.each(ACTIONS.map((spec) => [spec.action, spec] as const))(
    '%s lands only where the transitions allow',
    (_action, spec) => {
      for (const from of spec.from) {
        for (const to of spec.to) {
          expect(REQUEST_TRANSITIONS[from]).toContain(to);
        }
      }
    },
  );

  it('offers nothing at all once a request is finished', () => {
    for (const status of TERMINAL_STATUSES) {
      expect(availableActions(request({ status }), actor(REQUESTER))).toEqual(
        [],
      );
    }
  });

  it('names every action exactly once', () => {
    expect(new Set(names([...ACTIONS])).size).toBe(ACTIONS.length);
  });

  it('recognises only actions the flow declares', () => {
    expect(toRequestAction('receive')).toBe('receive');
    expect(toRequestAction('delete_everything')).toBeNull();
  });
});

/**
 * Each of these mirrors the check the handler in `requests.service.ts` makes.
 * They are the reason a caller can trust the list: an action offered here is
 * one that will not answer `FORBIDDEN`.
 */
describe('authority matches the handler, role by role', () => {
  it('lets only the named receiver accept a ticket', () => {
    const submitted = request({ status: 'submitted' });

    expect(names(availableActions(submitted, actor(RECEIVER)))).toContain(
      'receive',
    );
    // Narrower than `carrier` on purpose — accepting is not delegable, and
    // `receive` in the service compares `receiverUserId` alone.
    expect(names(availableActions(submitted, actor(ASSIGNEE)))).not.toContain(
      'receive',
    );
    expect(names(availableActions(submitted, head))).not.toContain('receive');
  });

  it('lets whoever carries the work finish it, requester or not', () => {
    for (const person of [RECEIVER, ASSIGNEE]) {
      expect(names(availableActions(request(), actor(person)))).toContain(
        'complete',
      );
    }

    expect(names(availableActions(request(), actor(REQUESTER)))).not.toContain(
      'complete',
    );
  });

  it('lets the requester and a group head withdraw, and nobody else', () => {
    expect(names(availableActions(request(), actor(REQUESTER)))).toContain(
      'cancel',
    );
    expect(names(availableActions(request(), head))).toContain('cancel');
    expect(names(availableActions(request(), actor(STRANGER)))).not.toContain(
      'cancel',
    );
  });

  it('lets only the requester close an accepted result', () => {
    const approved = request({ status: 'approved' });

    expect(names(availableActions(approved, actor(REQUESTER)))).toContain(
      'close',
    );
    expect(names(availableActions(approved, actor(RECEIVER)))).not.toContain(
      'close',
    );
  });

  /*
    An approved request is finished being worked on but is not closed, so it
    is still cancellable per the transition table — while `complete`, `hold`
    and the rest are gone. The list is the flow's answer, not a fixed menu.
  */
  it('offers only what is still reachable once the result is accepted', () => {
    expect(
      names(
        availableActions(request({ status: 'approved' }), actor(REQUESTER)),
      ),
    ).toEqual(['cancel', 'close', 'comment', 'create_child']);
  });

  /*
    "rollback" in the chatbot use case. Reachable by the team holding the
    ticket and by a head above it — the same rule `returnToRequester` gained
    on 3 ก.ย. 2569, when it turned out to have had none.
  */
  it('lets the carrier or a head send a ticket back, but not a stranger', () => {
    expect(names(availableActions(request(), actor(ASSIGNEE)))).toContain(
      'return',
    );
    expect(names(availableActions(request(), head))).toContain('return');
    expect(names(availableActions(request(), actor(STRANGER)))).not.toContain(
      'return',
    );
  });

  it('reaches a group through a scope grant only when it may act', () => {
    const granted = actor(STRANGER, { scopedActUnitIds: [DEPT] });
    const readOnly = actor(STRANGER, { scopedActUnitIds: [] });

    expect(hasAuthority('carrier_or_lead', request(), granted)).toBe(true);
    expect(hasAuthority('carrier_or_lead', request(), readOnly)).toBe(false);
  });

  /*
    A grant written to one person (4 ก.ย. 2569) reaches that person work
    wherever it sits, which is the point of writing it to a person rather than
    to their group.
  */
  it('reaches a person through a scope grant only when it may act', () => {
    const granted = actor(STRANGER, { scopedActUserIds: [ASSIGNEE] });
    const readOnly = actor(STRANGER, { scopedActUserIds: [] });

    expect(hasAuthority('carrier_or_lead', request(), granted)).toBe(true);
    expect(hasAuthority('carrier_or_lead', request(), readOnly)).toBe(false);
  });

  it('reaches the requester side of a grant to a person too', () => {
    const granted = actor(STRANGER, { scopedActUserIds: [REQUESTER] });

    expect(hasAuthority('requester_or_lead', request(), granted)).toBe(true);
  });

  /*
    The whole reason `scopedUserIds` and `scopedActUserIds` are two lists: a
    grant is read-only by default, and reading somebody ticket must never be
    enough to move it.
  */
  it('never lets a grant to a person reach somebody it does not name', () => {
    const elsewhere = actor(STRANGER, { scopedActUserIds: ['user-nobody'] });

    expect(hasAuthority('carrier_or_lead', request(), elsewhere)).toBe(false);
    expect(hasAuthority('requester_or_lead', request(), elsewhere)).toBe(false);
  });

  it('leaves a stranger with only what needs no authority', () => {
    expect(names(availableActions(request(), actor(STRANGER)))).toEqual([
      'comment',
      'create_child',
    ]);
  });
});

/**
 * The point of building the list from the flow rather than for one use case:
 * a type with no approval ladder never shows approval actions, and a type with
 * one shows them without any code being written for it.
 */
describe('approval actions follow the configuration, not a hard-coded list', () => {
  it('never offers a decision on a request that is not being checked', () => {
    for (const status of Object.values(RequestStatus)) {
      if (status === 'pending_approval') continue;

      const offered = names(
        availableActions(request({ status }), actor(REQUESTER), true),
      );

      expect(offered).not.toContain('approve');
      expect(offered).not.toContain('reject');
      expect(offered).not.toContain('send_back');
    }
  });

  it('offers all three to a candidate on the pending step', () => {
    const checking = request({ status: 'pending_approval' });

    expect(names(availableActions(checking, actor(STRANGER), true))).toEqual([
      'approve',
      'reject',
      'send_back',
      'comment',
      'create_child',
    ]);
  });

  it('offers none of them to somebody who is not a candidate', () => {
    const checking = request({ status: 'pending_approval' });

    expect(names(availableActions(checking, actor(STRANGER), false))).toEqual([
      'comment',
      'create_child',
    ]);
  });
});
