import {
  AGENT_ACTIONS,
  isAgentAction,
  type AgentAction,
} from './agent-actions';

export const MIN_TIMEOUT_MINUTES = 1;
export const MAX_TIMEOUT_MINUTES = 1440;

export interface ActionEndpoint {
  endpointId: string;
  timeoutMinutes: number;
}

export type ConnectionEndpoints = Partial<Record<AgentAction, ActionEndpoint>>;

/**
 * Reads `outbound_connections.endpoints`. Entries for actions that no longer
 * exist, or without an endpoint id, are dropped; a missing or out-of-range
 * timeout falls back to the action's default.
 */
export function parseEndpoints(raw: unknown): ConnectionEndpoints {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const parsed: ConnectionEndpoints = {};
  for (const [action, value] of Object.entries(raw)) {
    if (!isAgentAction(action) || !value || typeof value !== 'object') continue;
    const { endpointId, timeoutMinutes } = value as Record<string, unknown>;
    if (typeof endpointId !== 'string' || !endpointId) continue;
    parsed[action] = {
      endpointId,
      timeoutMinutes: validTimeout(timeoutMinutes)
        ? timeoutMinutes
        : AGENT_ACTIONS[action].defaultTimeoutMinutes,
    };
  }
  return parsed;
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
