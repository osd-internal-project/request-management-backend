import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  CurrentPrincipal,
  Permissions,
  SensitiveResource,
  ServiceAccountOnly,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import { notImplemented } from '../common/not-implemented';
import { RequestsService } from './requests.service';
import {
  CancelRequestDto,
  CreateRequestDto,
  ListRequestsQueryDto,
  ReturnRequestDto,
  UpdateRequestDto,
} from './dto/request.dto';

/**
 * §11.4 group C — Platform Request (S3).
 *
 * Screens: §16 หน้าที่ 2 (งานค้างของฉัน), หน้าที่ 3 (ยื่นคำขอ),
 * หน้าที่ 4 (รายละเอียด + ไทม์ไลน์). State transitions live in
 * `request-state-machine.ts`.
 */
@ApiTags('requests')
@ApiBearerAuth()
@Controller()
export class RequestsController {
  constructor(private readonly requests: RequestsService) {}

  /** REQ-01: types are configuration — the form comes from `formSchema`. */
  @Get('request-types')
  @Permissions('request.create')
  listTypes(@CurrentPrincipal() principal: Principal) {
    return this.requests.listTypes(principal);
  }

  @Post('requests')
  @Permissions('request.create')
  create(
    @Body() dto: CreateRequestDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.requests.create(dto, principal);
  }

  @Patch('requests/:id')
  @Permissions('request.create')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateRequestDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.requests.update(id, dto, principal);
  }

  @Post('requests/:id/attachments')
  @Permissions('request.create')
  addAttachment(@Param('id') _id: string, @Body() _body: unknown) {
    // REQ-03: needs the object-storage backend named in open question G.
    return notImplemented('REQ-03');
  }

  @Delete('requests/:id/attachments/:attachmentId')
  @Permissions('request.create')
  removeAttachment(
    @Param('id') _id: string,
    @Param('attachmentId') _attachmentId: string,
  ) {
    return notImplemented('REQ-03');
  }

  /**
   * REQ-02/03 + APV-02 + SUP-01 — issues the number, computes the chain and
   * starts the clock. Missing fields or documents stop it before anything is
   * reserved.
   */
  @Post('requests/:id/submit')
  @Permissions('request.create')
  submit(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
    @Headers('authorization') authorization: string,
  ) {
    return this.requests.submit(id, principal, authorization);
  }

  /** REQ-08 — งานค้างของฉัน (§16 หน้าที่ 2). */
  @Get('requests')
  @Permissions('request.read')
  list(
    @CurrentPrincipal() principal: Principal,
    @Query() query: ListRequestsQueryDto,
  ) {
    return this.requests.list(principal, query);
  }

  /** Margin is stripped for callers without `request.sensitive.read`. */
  @Get('requests/:id')
  @Permissions('request.read')
  @SensitiveResource('request:DSC')
  findOne(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.requests.findOne(id, principal);
  }

  /** REQ-07 — the append-only timeline behind §16 หน้าที่ 4. */
  @Get('requests/:id/events')
  @Permissions('request.read')
  events(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.requests.events(id, principal);
  }

  /** REQ-04 — bounced back with a reason from the type's standard list. */
  @Post('requests/:id/return')
  @Permissions('request.return')
  returnToRequester(
    @Param('id') id: string,
    @Body() dto: ReturnRequestDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.requests.returnToRequester(id, dto, principal);
  }

  @Post('requests/:id/resubmit')
  @Permissions('request.create')
  resubmit(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
    @Headers('authorization') authorization: string,
  ) {
    return this.requests.submit(id, principal, authorization);
  }

  /** REQ-05 — cancelled with a reason. Never deleted. */
  @Post('requests/:id/cancel')
  @Permissions('request.cancel.own')
  cancel(
    @Param('id') id: string,
    @Body() dto: CancelRequestDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.requests.cancel(id, dto, principal);
  }

  @Post('requests/:id/complete')
  @Permissions('request.complete')
  complete(@Param('id') _id: string) {
    return notImplemented('REQ-08');
  }

  @Get('reports/request-bottleneck')
  @Permissions('report.request.read')
  bottleneckReport(@Query() _query: unknown) {
    return notImplemented('REQ-09');
  }

  /** REQ-10 / AUTH-06: raised by a system, via a service account. */
  @Post('integrations/requests')
  @Permissions('integration.request.create')
  @ServiceAccountOnly()
  createFromIntegration(@Body() _body: unknown) {
    return notImplemented('REQ-10');
  }
}

/** §11.4 request-type administration (§16 A2). */
@ApiTags('admin/request-types')
@ApiBearerAuth()
@Controller('admin/request-types')
export class RequestTypeAdminController {
  constructor(private readonly requests: RequestsService) {}

  @Get()
  @Permissions('admin.request-type.manage')
  list(@CurrentPrincipal() principal: Principal) {
    return this.requests.listTypes(principal);
  }

  @Post()
  @Permissions('admin.request-type.manage')
  create(@Body() _body: unknown) {
    return notImplemented('REQ-01');
  }

  @Patch(':code')
  @Permissions('admin.request-type.manage')
  update(@Param('code') _code: string, @Body() _body: unknown) {
    return notImplemented('REQ-01');
  }
}
