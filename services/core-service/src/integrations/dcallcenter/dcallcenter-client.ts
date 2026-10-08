/**
 * CD-292 — the company's own call centre (D-Callcenter), as AI SMART and
 * AI CARE (CD-287) both see it. One client for both: SMART dials out here;
 * CARE adds inbound calls and transfers to the same client later.
 *
 * Only a mock exists until D-Callcenter's specification arrives — a real
 * client is written against that document, not guessed (AGENTS.md: a gap is
 * reported, never filled).
 */

export const CALL_OUTCOMES = [
  'interested',
  'not_interested',
  'no_answer',
  'busy',
  'refused',
  'failed',
] as const;
export type CallOutcome = (typeof CALL_OUTCOMES)[number];

export interface OutboundCall {
  /** Our reference, returned with the result. */
  ref: string;
  /** The number to dial, 0-prefixed digits. */
  to: string;
  /** Said first: who is calling and how to refuse. */
  opening: string;
  /** What the AI says after the opening. */
  script: string;
}

/** What D-Callcenter reports when a call ends. */
export interface CallResult {
  callId: string;
  outcome: CallOutcome;
  durationSec?: number | null;
  transcript?: string | null;
  recordingRef?: string | null;
}

export interface DCallcenterClient {
  readonly mode: 'mock' | 'off';
  /**
   * Starts a call. The result usually arrives later through the callback
   * (`smart/calls/callback`); the mock answers at once in `result`.
   */
  placeCall(
    call: OutboundCall,
  ): Promise<{ callId: string; result?: CallResult }>;
}

export const DCALLCENTER_CLIENT = Symbol('DCALLCENTER_CLIENT');
