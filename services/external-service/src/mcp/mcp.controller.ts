import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import {
  ACTING_SCOPES,
  AnyPermission,
  CurrentPrincipal,
  type Principal,
  type RequestWithPrincipal,
  ServiceAccountAllowed,
} from '@request-management/share';
import { McpService } from './mcp.service';

/**
 * The MCP entrypoint — one URL for every tool.
 *
 * MCP is JSON-RPC, so the tool being called is named in the body rather than
 * in the path. There is no `/mcp/request-types`; there is this, and the ten
 * `/external/*` routes it borrows, which are unchanged.
 *
 * **Two kinds of caller, one endpoint.**
 *
 * `@ServiceAccountAllowed()` rather than `@ServiceAccountOnly()`: the whole
 * point of this door is that a *person's* token may come through it, which the
 * `Only` variant refuses. And `@AnyPermission` rather than `@Permissions`,
 * because the two callers hold different grants for the same work — a key
 * holds any scope that acts for a person (`ACTING_SCOPES`), a human has
 * `request.create`. Which tool a key may call is then judged per tool
 * against its `x-permission` (22 ต.ค. 2569).
 *
 * Neither weakens anything: whichever principal arrives, the tools run through
 * `ExternalService` with that principal, so row visibility, `assertMayAct` and
 * the audit trail apply to whoever it really is.
 */
@ApiTags('mcp')
@ApiBearerAuth()
@Controller('mcp')
@ServiceAccountAllowed()
@AnyPermission(...ACTING_SCOPES, 'request.create')
export class McpController {
  constructor(private readonly mcp: McpService) {}

  /**
   * `@Body() body: unknown` and not a DTO, deliberately.
   *
   * `ValidationPipe({ whitelist: true })` is global, and it **strips
   * properties no DTO declares** — which for a JSON-RPC envelope is the entire
   * `params` object, arriving empty with nothing to say it was emptied. The
   * shape is checked in `McpService` instead.
   */
  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'MCP (JSON-RPC) — initialize · tools/list · tools/call',
    description:
      'Endpoint เดียวสำหรับทุก tool — ชื่อ tool อยู่ใน body ไม่ใช่ใน path ' +
      'รายการ tool ทั้งหมดอยู่ที่ docs/openapi/external-tools.json ' +
      'ดูวิธีใช้ที่ docs/EXTERNAL_API.md',
  })
  async handle(
    @Body() body: unknown,
    @Req() request: RequestWithPrincipal,
    @CurrentPrincipal() principal: Principal,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const answer = await this.mcp.handle(body, request, principal);

    // A notification carries no `id`, and JSON-RPC forbids replying to one.
    if (answer === null) {
      response.status(HttpStatus.NO_CONTENT);
      return undefined;
    }

    return answer;
  }
}
