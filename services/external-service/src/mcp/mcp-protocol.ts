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
 * The revisions this server speaks, newest first.
 *
 * Echoing back whatever the client asks for is the other option and it is
 * worse: it would claim to speak a revision this code has never seen.
 */
export const PROTOCOL_VERSIONS = ['2025-06-18', '2024-11-05'] as const;

/** A client asking for a revision not listed gets the one LibreChat has always used. */
export const FALLBACK_PROTOCOL_VERSION = '2024-11-05';

/** `initialize`'s answer: the client's revision when this server speaks it. */
export function negotiateProtocol(requested: unknown): string {
  return isKnownProtocol(requested) ? requested : FALLBACK_PROTOCOL_VERSION;
}

export function isKnownProtocol(version: unknown): version is string {
  return (PROTOCOL_VERSIONS as readonly unknown[]).includes(version);
}

/** Sent on every HTTP request after `initialize` (2025-06-18 §Transports). */
export const PROTOCOL_VERSION_HEADER = 'mcp-protocol-version';

export const SERVER_INFO = {
  name: 'osd-request-management',
  version: '1.0.0',
} as const;

/**
 * CD-278 — how a chat must use these tools, sent once in `initialize`.
 *
 * `instructions` belongs to a later MCP revision than the one declared above;
 * a client that does not know it ignores it, and LibreChat reads it into the
 * agent's system prompt when the server is configured with
 * `serverInstructions: true` (docs/EXTERNAL_API.md §4.4). Kept here, beside
 * the tools it governs, rather than pasted into each chat client.
 */
export const SERVER_INSTRUCTIONS = [
  'คุณเป็นผู้ช่วยของระบบ Connect the Dot ตอบจากข้อมูลที่ tool คืนมาเท่านั้น',
  '1. ทุกข้อเท็จจริงในคำตอบต้องอ้างลิงก์ — ใช้ `link` ของแต่ละรายการ หรือ `source_link` ของคำตอบ ' +
    'เขียนเป็นลิงก์ markdown ที่กดได้ เช่น [OPP-0012](link)',
  '2. ถ้า tool คืนรายการว่าง หรือตอบ NOT_FOUND ให้บอกตรง ๆ ว่าไม่พบข้อมูล (หรือไม่มีสิทธิ์เห็น) ' +
    'ห้ามเดา ห้ามแต่งตัวเลข ชื่อ หรือรหัสเอกสารขึ้นเอง',
  '3. ถ้า tool ตอบ FORBIDDEN ให้บอกว่าบัญชีนี้ไม่มีสิทธิ์ดูข้อมูลส่วนนั้น อย่าพยายามหาทางอื่นมาตอบแทน',
  '4. ตัวเลขสรุปให้ยกมาจาก tool ตรง ๆ พร้อมลิงก์หน้าที่ตรวจสอบได้ อย่าคำนวณใหม่จากรายการที่เห็นไม่ครบ ' +
    '(ดู `total` เทียบกับจำนวนรายการ)',
  '5. คำถามกว้าง ๆ เช่น "วันนี้มีอะไรต้องทำ" ให้เริ่มที่ `assistant_get_summary`; ' +
    'คำถามวิธีทำ/แก้ปัญหาให้ค้น `assistant_get_kb_articles` ก่อนตอบ',
].join('\n');

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
