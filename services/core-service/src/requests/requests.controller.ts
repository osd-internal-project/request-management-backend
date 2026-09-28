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
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import {
  CurrentPrincipal,
  Permissions,
  SensitiveResource,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import { RequestsService } from './requests.service';
import { AttachmentsService } from './attachments.service';
import { BottleneckService } from '../reports/bottleneck.service';
import { BottleneckQueryDto } from '../reports/dto/report.dto';
import {
  CancelRequestDto,
  CreateRequestDto,
  HoldRequestDto,
  ListRequestsQueryDto,
  AssignRequestDto,
  ResumeRequestDto,
  ReturnRequestDto,
  UpdateRequestDto,
  UploadAttachmentDto,
  AddCommentDto,
  CloseRequestDto,
  CompleteRequestDto,
  CreateRequestTypeDto,
  UpdateRequestTypeDto,
  AdvanceRequestDto,
  StepFormDto,
  PublishFlowDto,
} from './dto/request.dto';
import { RequestFlowAdminService } from './request-flow-admin.service';

/** REQ-03 — per-file cap, enforced by multer before the bytes reach memory. */
const MAX_ATTACHMENT_BYTES = 104_857_600;

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
    private readonly attachments: AttachmentsService,
  ) {}

  /** REQ-01: types are configuration — the form comes from `formSchema`. */
  @Get('request-types')
  @Permissions('request.create')
  @ApiQuery({
    name: 'parent',
    required: false,
    description: 'Parent request id',
  })
  listTypes(
    @CurrentPrincipal() principal: Principal,
    @Query('parent') parentRequestId?: string,
  ) {
    return this.requests.listTypes(principal, parentRequestId);
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

  /** REQ-03 — uploads one document (multipart `file` + optional `doc_code`). */
  @Post('requests/:id/attachments')
  @Permissions('request.create')
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: { type: 'string', format: 'binary' },
        doc_code: { type: 'string' },
      },
    },
  })
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_ATTACHMENT_BYTES },
      // Browsers send the filename as raw UTF-8; multer's latin1 default garbles Thai.
      defParamCharset: 'utf8',
    }),
  )
  addAttachment(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() dto: UploadAttachmentDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.attachments.upload(id, file, dto.doc_code, principal);
  }

  /** REQ-03 — the stored file; visible to whoever may open the request. */
  @Get('requests/:id/attachments/:attachmentId/file')
  @Permissions('request.read')
  async downloadAttachment(
    @Param('id') id: string,
    @Param('attachmentId') attachmentId: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<StreamableFile> {
    const { attachment, stream } = await this.attachments.download(
      id,
      attachmentId,
      principal,
    );

    return new StreamableFile(stream, {
      type: attachment.mimeType,
      length: attachment.sizeBytes,
      disposition: `attachment; filename*=UTF-8''${encodeURIComponent(attachment.fileName)}`,
    });
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
   * REQ-02/03 + SUP-01 — issues the number and starts the clock. Missing
   * fields, missing documents or no named receiver stop it before anything is
   * reserved. The approval chain is no longer resolved here; see `complete`.
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

  /**
   * REQ-08 — งานค้างของฉัน (§16 หน้าที่ 2). Each row is masked by its own
   * type's rules (CD-127): one list holds many request types.
   */
  @Get('requests')
  @Permissions('request.read')
  @SensitiveResource('request:{typeCode}')
  list(
    @CurrentPrincipal() principal: Principal,
    @Query() query: ListRequestsQueryDto,
  ) {
    return this.requests.list(principal, query);
  }

  /**
   * Fields a masking rule declares for this request's type are stripped for
   * callers without its permission — the type read off the row, not fixed to
   * DSC, so a rule an admin adds for another type takes effect here too.
   */
  @Get('requests/:id')
  @Permissions('request.read')
  @SensitiveResource('request:{typeCode}')
  findOne(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.requests.detailFor(id, principal);
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

  /** The named receiver accepts the ticket — the working clock starts here. */
  @Post('requests/:id/receive')
  @Permissions('request.complete')
  receive(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.requests.receive(id, principal);
  }

  /** Hands the work on. `ASSIGNED` the first time, `HANDOVER` afterwards. */
  @Post('requests/:id/assign')
  @Permissions('request.complete')
  assign(
    @Param('id') id: string,
    @Body() dto: AssignRequestDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.requests.assign(id, dto, principal);
  }

  /**
   * REQ-08 — the doing team says the work is finished.
   *
   * Then the ticket branches: a type with a published matrix goes for a check,
   * one without is accepted as delivered. Needs the caller's token because the
   * approval chain resolves across a service boundary.
   */
  @Post('requests/:id/complete')
  @Permissions('request.complete')
  complete(
    @Param('id') id: string,
    @Body() dto: CompleteRequestDto,
    @CurrentPrincipal() principal: Principal,
    @Headers('authorization') authorization: string,
  ) {
    return this.requests.complete(id, principal, authorization, dto);
  }

  /** Moves the work to another step of the type's flow (forward or back). */
  @Post('requests/:id/advance')
  @Permissions('request.complete')
  advance(
    @Param('id') id: string,
    @Body() dto: AdvanceRequestDto,
    @CurrentPrincipal() principal: Principal,
    @Headers('authorization') authorization: string,
  ) {
    return this.requests.advance(id, dto, principal, authorization);
  }

  /** Saves draft answers to the current step's form. */
  @Patch('requests/:id/step-form')
  @Permissions('request.complete')
  saveStepForm(
    @Param('id') id: string,
    @Body() dto: StepFormDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.requests.saveStepForm(id, dto, principal);
  }

  /** The requester accepts the result and the ticket ends. */
  @Post('requests/:id/close')
  @Permissions('request.create')
  close(
    @Param('id') id: string,
    @Body() dto: CloseRequestDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.requests.close(id, principal, dto);
  }

  /** H2.2 — the สายคำขอ panel: this request, what it spawned, and its parent. */
  @Get('requests/:id/tree')
  @Permissions('request.read')
  tree(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.requests.tree(id, principal);
  }

  /**
   * H2.2 — leaves a note on a request.
   *
   * `request.read` rather than a permission of its own: the people who can open
   * a request are the people with something to say about it, and the service
   * re-checks visibility before writing.
   */
  @Post('requests/:id/comments')
  @Permissions('request.read')
  addComment(
    @Param('id') id: string,
    @Body() dto: AddCommentDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.requests.addComment(id, dto, principal);
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
}

/** §11.4 request-type administration (§16 A2). */
@ApiTags('admin/request-types')
@ApiBearerAuth()
@Controller('admin/request-types')
export class RequestTypeAdminController {
  constructor(
    private readonly requests: RequestsService,
    private readonly flows: RequestFlowAdminService,
  ) {}

  /** Every published version of the type's step flow, newest first. */
  @Get(':code/flows')
  @Permissions('admin.request-type.manage')
  listFlows(
    @Param('code') code: string,
    @CurrentPrincipal() principal: Principal,
    @Query('company_id') companyId?: string,
  ) {
    return this.flows.list(code, principal, companyId);
  }

  /** A v2 flow drafted from the type's current settings; nothing is written. */
  @Get(':code/flows/suggested')
  @Permissions('admin.request-type.manage')
  suggestedFlow(
    @Param('code') code: string,
    @CurrentPrincipal() principal: Principal,
    @Query('company_id') companyId?: string,
  ) {
    return this.flows.suggested(code, principal, companyId);
  }

  /** Publishes the next flow version; requests already submitted keep theirs. */
  @Post(':code/flows')
  @Permissions('admin.request-type.manage')
  publishFlow(
    @Param('code') code: string,
    @Body() dto: PublishFlowDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.flows.publish(code, dto, principal);
  }

  /** A1 passes `company_id`; A2 leaves it out and gets the active company. */
  @Get()
  @Permissions('admin.request-type.manage')
  list(
    @CurrentPrincipal() principal: Principal,
    @Query('company_id') companyId?: string,
  ) {
    return this.requests.listAdminTypes(principal, companyId);
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

  /**
   * Removes a type outright. Refused with `REQ_TYPE_IN_USE` once anything has
   * been raised against it — see `RequestsService.deleteType`.
   */
  @Delete(':code')
  @Permissions('admin.request-type.manage')
  @HttpCode(204)
  async deleteType(
    @Param('code') code: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<void> {
    await this.requests.deleteType(code, principal);
  }
}
