import type { RequestWithType } from './request.repository';

/**
 * When in a request's life an approval happens — and therefore which ladder it
 * uses and whose chart that ladder climbs.
 *
 * A type may configure **both**. Which stages are switched on is not a column:
 * it is whether a matrix has been published for the stage's subject, which is
 * the test `complete` has always used. Adding a stage is publishing a ladder.
 *
 * The after-work subject is unchanged (`request:<CODE>`), so every ladder that
 * exists today keeps routing exactly what it routed before.
 */
export interface ApprovalStage {
  /** Recorded on the `request.routed` event, so the timeline says which. */
  readonly name: 'pre' | 'post';
  /** The `ApprovalMatrix.subjectType` this stage routes against. */
  subjectOf(typeCode: string): string;
  /**
   * Whose place in the org chart a `หัวหน้าทีม` level counts up from.
   *
   * Null falls back to the requester in the approval engine, which is what a
   * request with no receiver yet has to do.
   */
  chartOwnerOf(request: RequestWithType): string | null;
  /**
   * Whether "no matrix" means the work is accepted as delivered.
   *
   * True only after the work: a completed request with no ladder is done. The
   * same absence before the work means "no permission needed", which is a
   * hand-off, not an acceptance — and is the state all 45 types are in until
   * somebody publishes a `:pre` ladder.
   */
  readonly recordsAcceptance: boolean;
}

/** §7.1's order: permission to start, before the receiver ever sees it. */
export const BEFORE_WORK: ApprovalStage = {
  name: 'pre',
  subjectOf: (typeCode) => `request:${typeCode}:pre`,
  // The requester is asking their own line of management for permission.
  chartOwnerOf: (request) => request.requesterId,
  recordsAcceptance: false,
};

/** The amendment's order: a check on the result, after the work is done. */
export const AFTER_WORK: ApprovalStage = {
  name: 'post',
  subjectOf: (typeCode) => `request:${typeCode}`,
  /*
    Whoever actually carried the work, not whoever asked for it.

    `assigneeUserId` first: a ticket handed on belongs to the person holding it
    now, and their head is the one who can judge what was delivered.
  */
  chartOwnerOf: (request) =>
    request.assigneeUserId ?? request.receiverUserId ?? null,
  recordsAcceptance: true,
};
