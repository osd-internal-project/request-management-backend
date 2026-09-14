/**
 * An MCP server whose whole job is handing you a Keycloak access token.
 *
 *   yarn mcp:token          # speaks MCP over stdin/stdout
 *
 * The External API takes two credentials in the same `Authorization` header —
 * an `rfk_` API key, or a Keycloak service-account token. The key is minted by
 * `libs/prisma/api-key.ts` and printed once; the token is what you reach for
 * when you have no key in hand, and getting one by typing a `curl` with a
 * client secret in it is exactly the thing that ends up in shell history.
 *
 * **Only a token. No request endpoints.** The nine External API calls are
 * already described for tool-callers in `docs/openapi/external-tools.json`;
 * wrapping them again here would be a second copy to keep in step.
 *
 * Written against the protocol directly rather than against
 * `@modelcontextprotocol/sdk`: a stdio MCP server is JSON-RPC on two pipes and
 * three methods, and this monorepo carries 25 dependencies in total. The
 * trade-off is that a future protocol revision is ours to follow.
 *
 * **stdout is the protocol.** Nothing may be written there but framed JSON-RPC
 * — a stray `console.log` corrupts the stream and the client fails to parse,
 * which looks nothing like the logging mistake it is. Diagnostics go to stderr.
 */
import { createInterface } from 'node:readline';

/**
 * The revision this server speaks.
 *
 * Echoed back to whatever the client asks for is the other option and it is
 * worse: it would claim to speak a revision this code has never seen.
 */
const PROTOCOL_VERSION = '2024-11-05';

const TOOL_NAME = 'get_keycloak_token';

/** Same ceiling `ApiKeyService.integrationToken` gives the same call. */
const TOKEN_TIMEOUT_MS = 20_000;

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface KeycloakTokenResponse {
  access_token?: string;
  expires_in?: number;
  token_type?: string;
}

interface Settings {
  baseUrl: string;
  realm: string;
  clientId: string;
  clientSecret: string;
}

/**
 * The four values this needs, or a sentence saying which are missing.
 *
 * The wording matches `api-key.service.ts:128-131` deliberately: somebody who
 * hits the same wall through the API and through this server should find one
 * answer, not two that have to be recognised as the same problem.
 */
function readSettings(): Settings | string {
  const baseUrl = process.env.KEYCLOAK_BASE_URL ?? '';
  const realm = process.env.KEYCLOAK_REALM ?? '';
  const clientId = process.env.INTEGRATION_CLIENT_ID ?? '';
  const clientSecret = process.env.INTEGRATION_CLIENT_SECRET ?? '';

  if (!clientId || !clientSecret) {
    return (
      'ระบบยังไม่ได้ตั้งค่า INTEGRATION_CLIENT_ID / INTEGRATION_CLIENT_SECRET\n' +
      'ทั้งสองค่าใช้ค่าเดียวกับ KEYCLOAK_CLIENT_ID / KEYCLOAK_CLIENT_SECRET ใน .env — ' +
      'ดู docs/EXTERNAL_API.md'
    );
  }

  if (!baseUrl || !realm) {
    return 'ระบบยังไม่ได้ตั้งค่า KEYCLOAK_BASE_URL / KEYCLOAK_REALM';
  }

  return { baseUrl, realm, clientId, clientSecret };
}

/**
 * A client-credentials token, minted fresh.
 *
 * Not cached, unlike `ApiKeyService`: that one mints on the path of every
 * request and reuse is what keeps Keycloak out of the hot path. Here a call is
 * a person asking for a token to paste somewhere, and handing back one already
 * half spent would be the wrong kind of thrift.
 */
async function mintToken(settings: Settings): Promise<KeycloakTokenResponse> {
  const url = `${settings.baseUrl}/realms/${settings.realm}/protocol/openid-connect/token`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: settings.clientId,
      client_secret: settings.clientSecret,
    }),
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  });

  if (!response.ok) {
    /*
      The body is quoted because Keycloak says something useful here
      (`invalid_client`, `unauthorized_client`) — and it never contains the
      secret that was sent, only a verdict on it.
    */
    throw new Error(
      `Keycloak ปฏิเสธคำขอ token (HTTP ${response.status}): ${await response.text()}`,
    );
  }

  const body = (await response.json()) as KeycloakTokenResponse;

  if (!body.access_token) {
    throw new Error('Keycloak ตอบกลับโดยไม่มี access_token');
  }

  return body;
}

/** The roles inside a token, read without verifying it — display only. */
function realmRolesOf(accessToken: string): string[] {
  try {
    const payload = accessToken.split('.')[1] ?? '';
    const decoded = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    ) as { realm_access?: { roles?: string[] } };

    return decoded.realm_access?.roles ?? [];
  } catch {
    // A token this server cannot read is still a token the caller can use.
    return [];
  }
}

/**
 * What the tool answers with.
 *
 * The header line is the point: the next thing that happens to this token is
 * that somebody pastes it into Postman or into Swagger's Authorize box, and
 * assembling `Bearer ` in front of it by hand is a step at which people
 * reliably paste one word too few.
 *
 * The roles are printed because the failure that follows a *successful* token
 * is `FORBIDDEN` from the External API, and the reason is always that
 * `integration.request.create` is not among them.
 */
function tokenReport(body: KeycloakTokenResponse): string {
  const accessToken = body.access_token ?? '';
  const roles = realmRolesOf(accessToken);
  const minutes = Math.round((body.expires_in ?? 0) / 60);

  return [
    `Authorization: ${body.token_type ?? 'Bearer'} ${accessToken}`,
    '',
    `หมดอายุใน: ${body.expires_in ?? '?'} วินาที (~${minutes} นาที)`,
    `realm roles: ${roles.length ? roles.join(', ') : '(อ่านไม่ได้)'}`,
    roles.includes('integration.request.create')
      ? ''
      : 'เตือน: ไม่มี integration.request.create — External API จะตอบ FORBIDDEN ' +
        'ให้รัน yarn keycloak:provision',
    '',
    'ใช้กับ External API คู่กับ header X-Acting-User: <อีเมลของคนที่ระบบทำแทน>',
  ]
    .filter(Boolean)
    .join('\n');
}

/** One JSON-RPC message, framed the way MCP frames it: one line of JSON. */
function send(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}

function replyWithText(id: JsonRpcRequest['id'], text: string): void {
  send({ id, result: { content: [{ type: 'text', text }] } });
}

async function handle(request: JsonRpcRequest): Promise<void> {
  switch (request.method) {
    case 'initialize':
      send({
        id: request.id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'keycloak-token', version: '1.0.0' },
        },
      });
      return;

    /*
      Notifications carry no `id` and take no reply — answering one is a
      protocol error, not a harmless extra.
    */
    case 'notifications/initialized':
      return;

    case 'tools/list':
      send({
        id: request.id,
        result: {
          tools: [
            {
              name: TOOL_NAME,
              description:
                'ขอ access token ของ service account จาก Keycloak ' +
                '(client_credentials) สำหรับยิง External API ผ่าน Postman ' +
                'หรือ Swagger — คืนบรรทัด Authorization ที่วางได้เลย',
              inputSchema: { type: 'object', properties: {} },
            },
          ],
        },
      });
      return;

    case 'tools/call': {
      if (request.params?.name !== TOOL_NAME) {
        send({
          id: request.id,
          error: { code: -32602, message: `ไม่รู้จัก tool "${String(request.params?.name)}"` },
        });
        return;
      }

      const settings = readSettings();

      /*
        Configuration problems come back as tool *content*, not as a JSON-RPC
        error: the person reading it needs to act on the sentence, and an
        error frame is shown to them as a failed call with the reason folded
        away.
      */
      if (typeof settings === 'string') {
        replyWithText(request.id, settings);
        return;
      }

      try {
        replyWithText(request.id, tokenReport(await mintToken(settings)));
      } catch (error) {
        replyWithText(
          request.id,
          error instanceof Error ? error.message : String(error),
        );
      }
      return;
    }

    default:
      // A request must be answered even when the method is unknown; a
      // notification (no `id`) must not be.
      if (request.id === undefined || request.id === null) return;

      send({
        id: request.id,
        error: { code: -32601, message: `ไม่รองรับเมท็อด "${request.method}"` },
      });
  }
}

function main(): void {
  const lines = createInterface({ input: process.stdin });

  lines.on('line', (line) => {
    const text = line.trim();
    if (!text) return;

    let request: JsonRpcRequest;
    try {
      request = JSON.parse(text) as JsonRpcRequest;
    } catch {
      send({
        id: null,
        error: { code: -32700, message: 'อ่าน JSON ไม่ได้' },
      });
      return;
    }

    void handle(request).catch((error: unknown) => {
      // Last resort: never let a rejection kill the process mid-session, and
      // never let it reach stdout as anything but a frame.
      send({
        id: request.id ?? null,
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    });
  });
}

main();
