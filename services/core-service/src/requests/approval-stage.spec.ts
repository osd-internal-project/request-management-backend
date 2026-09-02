import { AFTER_WORK, BEFORE_WORK } from './approval-stage';
import type { RequestWithType } from './request.repository';

function request(overrides: Partial<RequestWithType> = {}): RequestWithType {
  return {
    id: 'req-1',
    typeCode: 'DSC',
    requesterId: 'user-requester',
    receiverUserId: 'user-receiver',
    assigneeUserId: null,
    ...overrides,
  } as unknown as RequestWithType;
}

/**
 * A type may configure both stages. Which are on is not a column — it is
 * whether a ladder has been published for the stage's subject, so these two
 * strings are what decides the whole feature.
 */
describe('the two approval stages route against different subjects', () => {
  it('leaves the after-work subject exactly as it was', () => {
    // Every matrix published before 1 ก.ย. 2569 carries this string. Changing
    // it would silently unroute all of them.
    expect(AFTER_WORK.subjectOf('DSC')).toBe('request:DSC');
  });

  it('gives the pre-work stage a subject of its own', () => {
    expect(BEFORE_WORK.subjectOf('DSC')).toBe('request:DSC:pre');
  });

  /** `decide` tells the stages apart by this suffix and nothing else. */
  it('makes the pre-work subject recognisable by its suffix', () => {
    expect(BEFORE_WORK.subjectOf('MK-01').endsWith(':pre')).toBe(true);
    expect(AFTER_WORK.subjectOf('MK-01').endsWith(':pre')).toBe(false);
  });
});

describe("a supervisor level climbs the right person's chart", () => {
  /** Permission to ask is asked of your own line of management. */
  it('counts up from the requester before the work', () => {
    expect(BEFORE_WORK.chartOwnerOf(request())).toBe('user-requester');
  });

  /**
   * The reported defect: a request raised by Sales and delivered by Marketing
   * was routing to Sales' managers to sign off Marketing's output.
   */
  it('counts up from the receiver after the work', () => {
    expect(AFTER_WORK.chartOwnerOf(request())).toBe('user-receiver');
  });

  /** A ticket handed on belongs to whoever is holding it now. */
  it('prefers the assignee over the receiver once work is handed over', () => {
    expect(
      AFTER_WORK.chartOwnerOf(request({ assigneeUserId: 'user-assignee' })),
    ).toBe('user-assignee');
  });

  /**
   * Null, not the requester. The approval engine falls back to the requester
   * itself; deciding that here as well would put the rule in two places.
   */
  it('answers null when nobody is carrying the request', () => {
    expect(
      AFTER_WORK.chartOwnerOf(
        request({ receiverUserId: null, assigneeUserId: null }),
      ),
    ).toBeNull();
  });
});

describe('what "no matrix" means depends on the stage', () => {
  /**
   * A completed request with no ladder is done — 18 of OSD's 40 types are
   * Pattern C, "คำขอนี้ไม่มีชั้นอนุมัติ".
   */
  it('accepts the delivered result when there is no after-work ladder', () => {
    expect(AFTER_WORK.recordsAcceptance).toBe(true);
  });

  /**
   * The same absence before the work means "no permission needed" — a hand-off
   * to the receiver, not an acceptance. This is the state every type is in
   * until somebody publishes a `:pre` ladder, so getting it wrong would move
   * all 45 of them.
   */
  it('just hands the ticket on when there is no pre-work ladder', () => {
    expect(BEFORE_WORK.recordsAcceptance).toBe(false);
  });
});
