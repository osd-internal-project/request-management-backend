/**
 * MCP over HTTP — the External API as tools a chat client can call.
 *
 * One endpoint carries everything: the tool being called is named in the body,
 * not in the path, so adding a tool adds no URL. See `mcp.controller.ts`.
 *
 * **This does not replace `/external/*`.** Those ten routes are untouched and
 * every existing integration keeps working exactly as it did. What this adds
 * is a second door for callers that speak MCP, and — through a person's own
 * token — the ability to know *which* person without trusting a header.
 */
import { Injectable, Logger } from '@nestjs/common';
import {
  AppError,
  type Principal,
  type RequestWithPrincipal,
} from '@request-management/share';
import {
  isNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  PROTOCOL_VERSION,
  RPC_INTERNAL_ERROR,
  RPC_INVALID_PARAMS,
  RPC_INVALID_REQUEST,
  RPC_METHOD_NOT_FOUND,
  rpcError,
  rpcResult,
  SERVER_INFO,
  SERVER_INSTRUCTIONS,
  toolResult,
} from './mcp-protocol';
import { getApiKey, McpCallLogService } from '@request-management/core-service';
import { McpToolRegistry } from './mcp-tools';
import { McpActorService } from './mcp-actor';

@Injectable()
export class McpService {
  private readonly logger = new Logger(McpService.name);

  constructor(
    private readonly tools: McpToolRegistry,
    private readonly actors: McpActorService,
    private readonly callLog: McpCallLogService,
  ) {}

  /**
   * Answers one JSON-RPC message, or `null` for a notification.
   *
   * `null` is not "nothing went wrong" — it means the message carried no `id`
   * and the protocol forbids a reply. The controller turns it into `204`.
   */
  async handle(
    body: unknown,
    request: RequestWithPrincipal,
    caller: Principal,
  ): Promise<JsonRpcResponse | null> {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      // Batches are valid JSON-RPC but MCP clients do not send them, and
      // answering half a batch is worse than refusing the whole thing.
      return rpcError(null, RPC_INVALID_REQUEST, 'ต้องเป็น JSON-RPC object');
    }

    const rpc = body as JsonRpcRequest;

    switch (rpc.method) {
      case 'initialize':
        return rpcResult(rpc.id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          instructions: SERVER_INSTRUCTIONS,
        });

      case 'notifications/initialized':
        return null;

      case 'tools/list': {
        /*
          An empty list and a broken deployment look identical to a client, so
          the second one says so. `RPC_INTERNAL_ERROR` rather than an empty
          result: nothing the caller did is wrong, and this needs an operator.
        */
        const unavailable = this.tools.reasonUnavailable();
        if (unavailable) {
          return rpcError(
            rpc.id,
            RPC_INTERNAL_ERROR,
            `MCP ปิดใช้งาน: ${unavailable}`,
          );
        }

        return rpcResult(rpc.id, { tools: this.tools.list() });
      }

      case 'tools/call':
        return this.callTool(rpc, request, caller);

      default:
        if (isNotification(rpc)) return null;

        return rpcError(
          rpc.id,
          RPC_METHOD_NOT_FOUND,
          `ไม่รองรับเมท็อด "${String(rpc.method)}"`,
        );
    }
  }

  private async callTool(
    rpc: JsonRpcRequest,
    request: RequestWithPrincipal,
    caller: Principal,
  ): Promise<JsonRpcResponse> {
    const unavailable = this.tools.reasonUnavailable();
    if (unavailable) {
      return rpcError(
        rpc.id,
        RPC_INTERNAL_ERROR,
        `MCP ปิดใช้งาน: ${unavailable}`,
      );
    }

    const name = rpc.params?.name;

    if (typeof name !== 'string' || !this.tools.has(name)) {
      return rpcError(
        rpc.id,
        RPC_INVALID_PARAMS,
        `ไม่รู้จัก tool "${String(name)}"`,
      );
    }

    const args =
      typeof rpc.params?.arguments === 'object' && rpc.params.arguments !== null
        ? (rpc.params.arguments as Record<string, unknown>)
        : {};

    const started = Date.now();
    let actor: Principal | null = null;
    try {
      /*
        Identity is resolved per call, not per request: `initialize` and
        `tools/list` happen before anybody has been named, and demanding a
        user there would make the handshake impossible for the service-account
        route.
      */
      actor = await this.actors.resolve(request, caller);

      const value = await this.tools.call(name, args, {
        actor,
        authorization: request.headers.authorization ?? '',
        keyScopes: getApiKey(request)?.scopes,
      });

      this.log(caller, actor, name, args, started, { result: value });
      return rpcResult(rpc.id, toolResult(value));
    } catch (error) {
      const explained = this.explain(error);
      this.log(caller, actor, name, args, started, {
        errorCode: String(explained.code),
      });
      return rpcResult(rpc.id, toolResult(explained, true));
    }
  }

  /**
   * CD-279 — the AI audit log's line for this call. Not awaited: the log
   * never slows or fails the answer (`McpCallLogService` swallows its own
   * errors). A call whose person could not be resolved is still logged,
   * under the caller's company with no person.
   */
  private log(
    caller: Principal,
    actor: Principal | null,
    tool: string,
    args: Record<string, unknown>,
    started: number,
    outcome: { result?: unknown; errorCode?: string },
  ): void {
    void this.callLog.record({
      companyId: (actor ?? caller).activeCompanyId,
      userId: actor?.userId ?? null,
      viaServiceAccount: caller.isServiceAccount,
      tool,
      args,
      durationMs: Date.now() - started,
      ...outcome,
    });
  }

  /**
   * A failed tool reported as a *result*, not as a JSON-RPC error.
   *
   * The distinction matters to the model on the other end: a protocol error is
   * "your call was malformed", which it cannot recover from, while `isError`
   * with the reason attached is "that did not work, here is why" — which is
   * how it learns to ask for a missing field or pick a different action.
   *
   * `AppError`'s code is part of the API contract and travels with the text;
   * anything else is logged here and summarised, because an unexpected stack
   * is not something to hand to a chat client.
   */
  private explain(error: unknown): Record<string, unknown> {
    if (error instanceof AppError) {
      return {
        code: error.code,
        message: error.message,
        details: error.details,
      };
    }

    this.logger.error(
      `MCP tool failed: ${error instanceof Error ? error.stack : String(error)}`,
    );

    return { code: 'UNKNOWN', message: 'ระบบขัดข้องชั่วคราว' };
  }
}
