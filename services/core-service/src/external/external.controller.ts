import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiExtraModels,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Permissions, ServiceAccountOnly } from '@request-management/share';
import type { Principal } from '@request-management/share';
import { CurrentPrincipal } from '@request-management/share';
import { ACTING_USER_HEADER, ActingUserGuard } from './acting-user.guard';
import { ExternalService } from './external.service';
import { ApiExternalErrors } from './dto/external-errors.decorator';
import {
  ExternalActionDto,
  ExternalCreateRequestDto,
  ExternalListRequestsDto,
  ExternalTypeQueryDto,
} from './dto/external.dto';
import {
  ExternalActionsDto,
  ExternalCommentDto,
  ExternalRequestDto,
  ExternalRequestPageDto,
  ExternalTreeDto,
  ExternalTypeFormDto,
  ExternalTypeSummaryDto,
} from './dto/external-response.dto';

/**
 * The API an outside system drives the request flow through — built for the
 * "Aiyara" chatbot, and deliberately not built *around* it.
 *
 * Two credentials on every call. The bearer token is the integration's own
 * service account, which is what `@ServiceAccountOnly` and
 * `integration.request.create` check. `X-Acting-User` names the person it is
 * acting for, and `ActingUserGuard` swaps the principal to theirs before any
 * handler runs — so from that point the request is indistinguishable from the
 * same person working on a screen, and every rule about who may see and do
 * what applies without being restated here.
 *
 * Nothing on these routes is specific to a request type. The types offered
 * come from configuration, the fields from each type's `formSchema`, and the
 * actions from the state machine — so a second, third and thirtieth type work
 * the day they are configured, with no code written for them.
 */
@ApiTags('external')
@ApiExtraModels(ExternalCommentDto)
@ApiBearerAuth()
@ApiHeader({
  name: ACTING_USER_HEADER,
  required: true,
  description: 'อีเมลของผู้ใช้ที่ทำรายการ — ระบบจะทำงานในนามของคนนี้',
})
@Controller('external')
@ApiExternalErrors()
@ServiceAccountOnly()
@Permissions('integration.request.create')
@UseGuards(ActingUserGuard)
export class ExternalController {
  constructor(private readonly external: ExternalService) {}

  /** Step 2 — the request types this person may open. */
  @ApiOperation({ summary: 'ขั้น 2 — ประเภทคำขอที่ผู้ใช้รายนี้เปิดได้' })
  @ApiOkResponse({
    description: 'ประเภทคำขอที่เปิดได้ — ว่างได้ถ้าไม่มีอันไหนตรงเงื่อนไข',
    type: [ExternalTypeSummaryDto],
  })
  @Get('request-types')
  listTypes(
    @Query() query: ExternalTypeQueryDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.external.listTypes(principal, query);
  }

  /** Step 4 — the fields and options to ask for, straight from the type. */
  @ApiOperation({
    summary: 'ขั้น 3 — ฟอร์มและตัวเลือกที่ต้องถาม มาจากประเภทคำขอโดยตรง',
  })
  @ApiOkResponse({
    description: 'ฟอร์มของประเภทคำขอ พร้อมเหตุผลการตีกลับที่เลือกได้',
    type: ExternalTypeFormDto,
  })
  @Get('request-types/:code/form')
  formOf(
    @Param('code') code: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.external.formOf(code, principal);
  }

  /**
   * Steps 4 and 10 — raise a request, submitted, and get its number back.
   *
   * Pass `parent_request_id` to spawn one under an existing request; it is the
   * same call, because a child request is an ordinary request with a parent.
   *
   * Send `Idempotency-Key`. A chatbot retries, and without the header a
   * dropped response becomes two requests with two numbers.
   */
  @ApiOperation({
    summary: 'ขั้น 4 และ 10 — สร้างคำขอพร้อมยื่นในครั้งเดียว',
    description:
      'ส่ง `parent_request_id` เพื่อสร้างเป็นคำขอลูกของใบที่มีอยู่ — ' +
      'เป็น endpoint เดียวกัน เพราะคำขอลูกคือคำขอธรรมดาที่มีต้นเรื่อง ' +
      'ควรส่ง header `Idempotency-Key` ทุกครั้ง: ถ้า response หายกลางทาง ' +
      'การยิงซ้ำโดยไม่มี key จะกลายเป็นคำขอสองใบคนละเลข',
  })
  @ApiCreatedResponse({
    description:
      'คำขอที่ยื่นแล้ว — `requestNo` คือเลขที่ใช้อ้างต่อทุก endpoint',
    type: ExternalRequestDto,
  })
  @Post('requests')
  create(
    @Body() dto: ExternalCreateRequestDto,
    @CurrentPrincipal() principal: Principal,
    @Headers('authorization') authorization: string,
  ) {
    return this.external.createAndSubmit(dto, principal, authorization);
  }

  /** Steps 5 and 11 — this person's own queues. */
  @ApiOperation({ summary: 'ขั้น 5 และ 11 — คิวงานของผู้ใช้รายนี้' })
  @ApiOkResponse({
    description: 'คำขอหนึ่งหน้า พร้อมจำนวนรวมสำหรับแบ่งหน้า',
    type: ExternalRequestPageDto,
  })
  @Get('requests')
  list(
    @Query() query: ExternalListRequestsDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.external.list(principal, query);
  }

  /** Steps 7 and 13 — by uuid or by document number. */
  @ApiOperation({
    summary: 'ขั้น 7 และ 13 — อ่านคำขอด้วย uuid หรือเลขที่เอกสาร',
  })
  @ApiOkResponse({ description: 'คำขอใบนั้น', type: ExternalRequestDto })
  @Get('requests/:ref')
  findOne(@Param('ref') ref: string, @CurrentPrincipal() principal: Principal) {
    return this.external.findByRef(ref, principal);
  }

  /**
   * Steps 8 and 14 — what this person may do with it right now, and the
   * fields each of those needs.
   *
   * Ask this before offering choices. The answer follows the request's status
   * and this person's part in it, so it changes as the ticket moves.
   */
  @ApiOperation({
    summary: 'ขั้น 8 และ 14 — ตอนนี้ผู้ใช้รายนี้ทำอะไรกับคำขอได้บ้าง',
    description:
      'ถามก่อนเสนอตัวเลือกเสมอ คำตอบเปลี่ยนตามสถานะของคำขอ ' +
      'และบทบาทของผู้ใช้ในคำขอนั้น',
  })
  @ApiOkResponse({
    description: 'action ที่ทำได้ตอนนี้ พร้อมฟิลด์ที่แต่ละอันต้องใช้',
    type: ExternalActionsDto,
  })
  @Get('requests/:ref/actions')
  actions(@Param('ref') ref: string, @CurrentPrincipal() principal: Principal) {
    return this.external.actionsFor(ref, principal);
  }

  /**
   * Step 9 — do one of them.
   *
   * `:action` is a name from the list above. Each goes to the same service
   * method the web app calls, so the authority check, the state transition and
   * the audit entry are the ones already in force.
   */
  @ApiOperation({
    summary: 'ขั้น 9 — สั่งทำหนึ่งใน action ที่ได้จาก endpoint ด้านบน',
    description:
      '`comment` คืนตัว comment ที่เพิ่งเขียน (ExternalCommentDto) ' +
      'ส่วน action อื่นคืนคำขอหลังเปลี่ยนสถานะ (ExternalRequestDto)',
  })
  @ApiCreatedResponse({
    description:
      'คำขอหลังเปลี่ยนสถานะ หรือ comment ที่เพิ่งเขียน แล้วแต่ action',
    schema: {
      oneOf: [
        { $ref: '#/components/schemas/ExternalRequestDto' },
        { $ref: '#/components/schemas/ExternalCommentDto' },
      ],
    },
  })
  @Post('requests/:ref/actions/:action')
  perform(
    @Param('ref') ref: string,
    @Param('action') action: string,
    @Body() dto: ExternalActionDto,
    @CurrentPrincipal() principal: Principal,
    @Headers('authorization') authorization: string,
  ) {
    return this.external.perform(ref, action, dto, principal, authorization);
  }

  /** Step 14 — this request, its parent, and everything spawned under it. */
  @ApiOperation({ summary: 'ขั้น 14 — ใบนี้ ใบพ่อ และทุกใบลูกที่แตกออกไป' })
  @ApiOkResponse({
    description: 'ใบพ่อและใบลูกทั้งหมดของคำขอนี้',
    type: ExternalTreeDto,
  })
  @Get('requests/:ref/tree')
  tree(@Param('ref') ref: string, @CurrentPrincipal() principal: Principal) {
    return this.external.treeOf(ref, principal);
  }
}
