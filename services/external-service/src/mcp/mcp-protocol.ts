/**
 * The JSON-RPC shapes MCP speaks, and the framing helpers around them.
 *
 * Kept apart from the service so the protocol can be read on its own: what
 * follows in `mcp.service.ts` is about *this system's* tools, and mixing the
 * two makes it impossible to tell a protocol rule from a local decision.
 *
 * The same three methods `scripts/mcp-keycloak-token.ts` answers over stdio.
 * That server and this one are deliberately separate: one hands a human a
 * token to paste somewhere, the other carries the whole External API for a
 * chat client, and the transports have nothing in common below the message
 * shapes here.
 */

/**
 * The revision this server speaks.
 *
 * Echoing back whatever the client asks for is the other option and it is
 * worse: it would claim to speak a revision this code has never seen.
 */
export const PROTOCOL_VERSION = '2024-11-05';

export const SERVER_INFO = {
  name: 'osd-request-management',
  version: '1.0.0',
} as const;

/** JSON-RPC's own codes. Anything this system decides is a tool result. */
export const RPC_PARSE_ERROR = -32700;
export const RPC_INVALID_REQUEST = -32600;
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INVALID_PARAMS = -32602;
export const RPC_INTERNAL_ERROR = -32603;

export interface JsonRpcRequest {
  jsonrpc?: string;
  /** Absent means a notification: it is acted on and **never** answered. */
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** A notification carries no `id`; answering one is a protocol error. */
export function isNotification(request: JsonRpcRequest): boolean {
  return request.id === undefined || request.id === null;
}

export function rpcResult(
  id: JsonRpcRequest['id'],
  result: unknown,
): JsonRpcResponse {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

export function rpcError(
  id: JsonRpcRequest['id'],
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, data } };
}

/**
 * A tool's answer, as MCP frames one.
 *
 * `isError: true` is how a tool reports that *the work* failed — a request
 * that does not exist, an action the caller may not take. It is not a
 * protocol failure, so it must not come back as `rpcError`: the model needs
 * to read the reason and try something else, and a JSON-RPC error frame is
 * handed to it as a broken call instead of an answer.
 */
export function toolResult(value: unknown, isError = false): unknown {
  return {
    content: [
      {
        type: 'text',
        text:
          typeof value === 'string' ? value : JSON.stringify(value, null, 2),
      },
    ],
    ...(isError ? { isError: true } : {}),
  };
}
