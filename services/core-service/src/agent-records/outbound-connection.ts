import { AGENT_ACTIONS, type AgentAction } from './agent-actions';

export const MIN_TIMEOUT_MINUTES = 1;
export const MAX_TIMEOUT_MINUTES = 1440;

/** A row's own timeout, or the action's default when it has none (or one out of range). */
export function timeoutMinutesOf(
  action: AgentAction,
  stored: number | null,
): number {
  return validTimeout(stored)
    ? stored
    : AGENT_ACTIONS[action].defaultTimeoutMinutes;
}

function validTimeout(value: unknown): value is number {
  return (
    Number.isInteger(value) &&
    (value as number) >= MIN_TIMEOUT_MINUTES &&
    (value as number) <= MAX_TIMEOUT_MINUTES
  );
}

const VUVAGENT_ENDPOINT_PATH = /\/v1\/endpoints\/([A-Za-z0-9_-]+)\/?$/;

/**
 * Vuvagent's API page shows the whole endpoint URL, and that is what people
 * paste. `https://host/v1/endpoints/ep_1` → base `https://host` + id `ep_1`.
 */
export function splitVuvagentUrl(input: string): {
  baseUrl: string;
  endpointId: string | null;
} {
  const trimmed = input.trim();
  const match = VUVAGENT_ENDPOINT_PATH.exec(trimmed);
  const base = match ? trimmed.slice(0, match.index) : trimmed;
  return { baseUrl: base.replace(/\/+$/, ''), endpointId: match?.[1] ?? null };
}
