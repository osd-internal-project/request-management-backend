import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
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
import { RequestsService } from './requests.service';
import { BottleneckService } from '../reports/bottleneck.service';
import { BottleneckQueryDto } from '../reports/dto/report.dto';
import {
  CancelRequestDto,
  CreateRequestDto,
  HoldRequestDto,
  ListRequestsQueryDto,
  ResumeRequestDto,
  ReturnRequestDto,
  UpdateRequestDto,
  AddAttachmentDto,
  CreateIntegrationRequestDto,
  CreateRequestTypeDto,
  UpdateRequestTypeDto,
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
  constructor(
    private readonly requests: RequestsService,
    private readonly bottleneck: BottleneckService,
  ) {}

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

  /**
   * REQ-03 — records a document against the request.
   *
   * Metadata only: open question G has not named an object store, so no bytes
   * are accepted and there is deliberately **no download route**. The row is
   * still what lets `assertSubmittable` count required documents, without
   * which a type that demands one could never be submitted.
   */
  @Post('requests/:id/attachments')
  @Permissions('request.create')
  addAttachment(
    @Param('id') id: string,
    @Body() dto: AddAttachmentDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.requests.addAttachment(id, dto, principal);
  }

  /** REQ-03 — withdraws a document. Soft delete; the row stays for the trail. */
  @Delete('requests/:id/attachments/:attachmentId')
  @Permissions('request.create')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeAttachment(
    @Param('id') id: string,
    @Param('attachmentId') attachmentId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    await this.requests.removeAttachment(id, attachmentId, principal);
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

  /** §7.1 amendment — parked while waiting on an external factor. */
  @Post('requests/:id/hold')
  @Permissions('request.hold')
  hold(
    @Param('id') id: string,
    @Body() dto: HoldRequestDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.requests.hold(id, dto, principal);
  }

  /** §7.1 amendment — resumes held work; the clock owes what it owed. */
  @Post('requests/:id/resume')
  @Permissions('request.hold')
  resume(
    @Param('id') id: string,
    @Body() dto: ResumeRequestDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.requests.resume(id, dto, principal);
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

  /** REQ-08 — the receiving team closes the work and the clock stops. */
  @Post('requests/:id/complete')
  @Permissions('request.complete')
  complete(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.requests.complete(id, principal);
  }

  /** REQ-09 — mean/max time per approval step, slowest first. */
  @Get('reports/request-bottleneck')
  @Permissions('report.request.read')
  bottleneckReport(
    @Query() query: BottleneckQueryDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.bottleneck.report(query, principal);
  }

  /** REQ-10 / AUTH-06: raised by a system, via a service account. */
  @Post('integrations/requests')
  @Permissions('integration.request.create')
  @ServiceAccountOnly()
  createFromIntegration(
    @Body() dto: CreateIntegrationRequestDto,
    @CurrentPrincipal() principal: Principal,
    @Headers('authorization') authorization: string,
  ) {
    return this.requests.createFromIntegration(dto, principal, authorization);
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

  /** REQ-01 — a new type. Created inactive so it can be finished first. */
  @Post()
  @Permissions('admin.request-type.manage')
  create(
    @Body() dto: CreateRequestTypeDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.requests.createType(dto, principal);
  }

  /** REQ-01 — edits a type. Affects **new requests only** (§7 snapshot). */
  @Patch(':code')
  @Permissions('admin.request-type.manage')
  update(
    @Param('code') code: string,
    @Body() dto: UpdateRequestTypeDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.requests.updateType(code, dto, principal);
  }
}
