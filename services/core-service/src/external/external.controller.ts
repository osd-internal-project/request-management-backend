import {
  Body,
  Controller,
  Get,
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
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { Permissions, ServiceAccountOnly } from '@request-management/share';
import type { Principal } from '@request-management/share';
import { CurrentPrincipal } from '@request-management/share';
import { ACTIONS } from '../requests/available-actions';
import { ACTING_USER_HEADER_LABEL, ActingUserGuard } from './acting-user.guard';
import { BearerToken } from './bearer-token.decorator';
import { ExternalService } from './external.service';
import {
  ApiExternalReadErrors,
  ApiExternalWriteErrors,
} from './dto/external-errors.decorator';
import {
  ExternalActionDto,
  ExternalCreateRequestDto,
  ExternalListRequestsDto,
  ExternalSummaryDto as ExternalSummaryQueryDto,
  ExternalTypeQueryDto,
  ExternalUsersDto as ExternalUsersQueryDto,
} from './dto/external.dto';
import {
  ExternalActionsDto,
  ExternalCommentDto,
  ExternalRequestDto,
  ExternalRequestPageDto,
  ExternalSummaryDto,
  ExternalTreeDto,
  ExternalTypeFormDto,
  ExternalTypeSummaryDto,
  ExternalUserPageDto,
} from './dto/external-response.dto';

/**
 * Every action name the dispatcher accepts, read off the flow's own table.
 *
 * Derived rather than listed, for the reason `available-actions.ts` gives for
 * being a table at all: an action exists because the flow allows it. A hand-
 * written enum here would be a second list to forget to update, and the first
 * symptom would be a documented action the server rejects — or worse, a real
 * one the document never mentions.
 *
 * This is the set of *possible* names, not the set a given caller may use now.
 * That answer is per-request and comes from `GET .../actions`.
 */
const PERFORMABLE_ACTIONS = ACTIONS.map((spec) => spec.action).filter(
  /*
    `create_child` is in the flow's table because spawning a child is something
    the flow allows — but there is no verb to send for it. A child request is an
    ordinary request with a parent, raised through `POST external/requests`, and
    the dispatcher answers 400 to anyone who sends the name. Documenting it as a
    choice was documenting a button that does not work; `GET .../actions` now
    reports `can_create_child` instead.
  */
  (action) => action !== 'create_child',
);

/** `{ref}` means the same thing on all four routes that take it. */
const REF_PARAM = {
  name: 'ref',
  description:
    'เลขที่คำขอ หรือ uuid ก็ได้ — คนอ่านเลขที่จากอีเมลแล้วพิมพ์ ไม่ใช่ uuid',
  example: 'REQ-OSD-PS01-26090003',
} as const;

/**
 * Documentation for the header that stops a retry becoming a second request.
 *
 * `required: false` is the truth, not a courtesy: `IdempotencyInterceptor` lets
 * a POST with no key through and acts on it. Declaring it required would
 * describe an enforcement that does not exist, and the first client to omit it
 * would get a second document number instead of the 400 the document promised.
 *
 * Applied per-route rather than on the class because only the two POSTs reach
 * the interceptor at all.
 */
const IDEMPOTENCY_KEY_HEADER = {
  name: 'Idempotency-Key',
  required: false,
  description:
    'ควรส่งทุกครั้ง — หนึ่งค่าต่อหนึ่งเจตนา ' +
    'ยิงซ้ำด้วยค่าเดิมและ body เดิมจะได้ผลลัพธ์เดิมกลับไป ไม่เกิดรายการที่สอง ' +
    'ไม่ส่งก็ทำงานได้ แต่ response ที่หายกลางทางแล้ว retry จะกลายเป็นสองรายการ',
  schema: {
    type: 'string',
    example: '6f6bd3a7-7308-4d2e-a4de-75e1f89b6871',
  },
} as const;

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
  name: ACTING_USER_HEADER_LABEL,
  required: true,
  description: 'อีเมลของผู้ใช้ที่ทำรายการ — ระบบจะทำงานในนามของคนนี้',
})
@Controller('external')
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
  @ApiExternalReadErrors()
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
  @ApiExternalReadErrors()
  @ApiParam({
    name: 'code',
    description:
      'รหัสประเภทคำขอ จาก `code` ที่ `GET external/request-types` คืนมา',
    example: 'PS01',
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
  @ApiHeader(IDEMPOTENCY_KEY_HEADER)
  @ApiCreatedResponse({
    description:
      'คำขอที่ยื่นแล้ว — `requestNo` คือเลขที่ใช้อ้างต่อทุก endpoint',
    type: ExternalRequestDto,
  })
  @ApiExternalWriteErrors()
  @Post('requests')
  create(
    @Body() dto: ExternalCreateRequestDto,
    @CurrentPrincipal() principal: Principal,
    @BearerToken() authorization: string,
  ) {
    return this.external.createAndSubmit(dto, principal, authorization);
  }

  /** Steps 5 and 11 — this person's own queues. */
  @ApiOperation({ summary: 'ขั้น 5 และ 11 — คิวงานของผู้ใช้รายนี้' })
  @ApiOkResponse({
    description: 'คำขอหนึ่งหน้า พร้อมจำนวนรวมสำหรับแบ่งหน้า',
    type: ExternalRequestPageDto,
  })
  @ApiExternalReadErrors()
  @Get('requests')
  list(
    @Query() query: ExternalListRequestsDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.external.list(principal, query);
  }

  /**
   * How much work there is, without listing it.
   *
   * Declared **before** `requests/{ref}`: Nest matches in declaration order, so
   * the parameterised route would otherwise swallow `summary` and answer
   * "ไม่พบคำขอที่ระบุ" for a word that is not a document number.
   */
  @ApiOperation({
    summary: 'จำนวนคำขอแยกตามสถานะ — ตอบคำถาม "งานค้างกี่ใบ" ในครั้งเดียว',
    description:
      'รับ filter ชุดเดียวกับ `GET external/requests` และนับจากเงื่อนไขเดียวกัน ' +
      'ตัวเลขกับรายการเบื้องหลังจึงตรงกันเสมอ',
  })
  @ApiOkResponse({
    description: 'จำนวนแยกตามสถานะ พร้อมยอดรวมงานที่ยังไม่จบ',
    type: ExternalSummaryDto,
  })
  @ApiExternalReadErrors()
  @Get('requests/summary')
  summary(
    @Query() query: ExternalSummaryQueryDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.external.summary(principal, query);
  }

  /**
   * Look somebody up by name.
   *
   * Every id this API accepts is a uuid, and a person speaking to a chatbot
   * says a name. Scoped to what the acting user may see, by the same rule that
   * answers `GET /users` on the web.
   */
  @ApiOperation({
    summary: 'ค้นหาคนในบริษัท — แปลงชื่อหรืออีเมลเป็น id ที่ API รับ',
    description:
      'ใช้ `id` ที่ได้เป็น `receiver_user_id` ตอนเปิดคำขอ ' +
      'หรือ `assignee_user_id` ตอนมอบหมายงาน',
  })
  @ApiOkResponse({
    description: 'รายชื่อหนึ่งหน้า เรียงตามชื่อ',
    type: ExternalUserPageDto,
  })
  @ApiExternalReadErrors()
  @Get('users')
  searchUsers(
    @Query() query: ExternalUsersQueryDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.external.searchUsers(principal, query);
  }

  /** Steps 7 and 13 — by uuid or by document number. */
  @ApiOperation({
    summary: 'ขั้น 7 และ 13 — อ่านคำขอด้วย uuid หรือเลขที่เอกสาร',
  })
  @ApiOkResponse({ description: 'คำขอใบนั้น', type: ExternalRequestDto })
  @ApiExternalReadErrors()
  @ApiParam(REF_PARAM)
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
  @ApiExternalReadErrors()
  @ApiParam(REF_PARAM)
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
      'ส่วน action อื่นคืนคำขอหลังเปลี่ยนสถานะ (ExternalRequestDto) ' +
      '· **ทุก action มี field ที่บังคับต่างกัน** ดูจาก `fields` ที่ ' +
      '`GET external/requests/{ref}/actions` คืนมา — โดยเฉพาะ `approve`, `reject`, ' +
      '`send_back` ต้องมี `note` เสมอ ไม่งั้นได้ `400 VALIDATION_FAILED`',
  })
  @ApiParam(REF_PARAM)
  @ApiParam({
    name: 'action',
    description:
      'ต้องเป็นค่าที่ `GET external/requests/{ref}/actions` คืนมาสำหรับคนนี้ ณ ตอนนั้น ' +
      'ห้ามเดาจากรายการนี้ — รายการนี้คือ action ทั้งหมดที่ระบบมี ไม่ใช่ที่ทำได้ตอนนี้ ' +
      '`create_child` อยู่ในรายการแต่ยิงแล้วได้ 400 เสมอ: คำขอลูกสร้างด้วย ' +
      '`POST external/requests` พร้อม `parent_request_id`',
    enum: PERFORMABLE_ACTIONS,
    example: 'receive',
  })
  @ApiHeader(IDEMPOTENCY_KEY_HEADER)
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
  @ApiExternalWriteErrors()
  @Post('requests/:ref/actions/:action')
  perform(
    @Param('ref') ref: string,
    @Param('action') action: string,
    @Body() dto: ExternalActionDto,
    @CurrentPrincipal() principal: Principal,
    @BearerToken() authorization: string,
  ) {
    return this.external.perform(ref, action, dto, principal, authorization);
  }

  /** Step 14 — this request, its parent, and everything spawned under it. */
  @ApiOperation({ summary: 'ขั้น 14 — ใบนี้ ใบพ่อ และทุกใบลูกที่แตกออกไป' })
  @ApiOkResponse({
    description: 'ใบพ่อและใบลูกทั้งหมดของคำขอนี้',
    type: ExternalTreeDto,
  })
  @ApiExternalReadErrors()
  @ApiParam(REF_PARAM)
  @Get('requests/:ref/tree')
  tree(@Param('ref') ref: string, @CurrentPrincipal() principal: Principal) {
    return this.external.treeOf(ref, principal);
  }
}
