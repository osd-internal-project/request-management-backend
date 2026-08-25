import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Permissions, ServiceAccountOnly } from '@request-management/share';
import { notImplemented } from '../common/not-implemented';

/**
 * §11.4 group C — Platform Request. Delivered in **S3**.
 *
 * Routes and permissions are final; the bodies are not. See
 * `request-state-machine.ts` for the transitions these will enforce.
 */
@ApiTags('requests')
@ApiBearerAuth()
@Controller()
export class RequestsController {
  @Get('request-types')
  @Permissions('request.create')
  listTypes() {
    return notImplemented('REQ-01');
  }

  @Post('requests')
  @Permissions('request.create')
  createDraft(@Body() _body: unknown) {
    return notImplemented('REQ-01');
  }

  @Patch('requests/:id')
  @Permissions('request.create')
  updateDraft(@Param('id') _id: string, @Body() _body: unknown) {
    return notImplemented('REQ-01');
  }

  @Post('requests/:id/attachments')
  @Permissions('request.create')
  addAttachment(@Param('id') _id: string) {
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

  /** Issues the request number and starts the SLA clock (REQ-02, SUP-01). */
  @Post('requests/:id/submit')
  @Permissions('request.create')
  submit(@Param('id') _id: string) {
    return notImplemented('REQ-02');
  }

  @Get('requests')
  @Permissions('request.read')
  list(@Query() _query: unknown) {
    return notImplemented('REQ-08');
  }

  @Get('requests/:id')
  @Permissions('request.read')
  findOne(@Param('id') _id: string) {
    return notImplemented('REQ-07');
  }

  @Get('requests/:id/events')
  @Permissions('request.read')
  timeline(@Param('id') _id: string) {
    return notImplemented('REQ-07');
  }

  @Post('requests/:id/return')
  @Permissions('request.return')
  returnToRequester(@Param('id') _id: string, @Body() _body: unknown) {
    return notImplemented('REQ-04');
  }

  @Post('requests/:id/resubmit')
  @Permissions('request.create')
  resubmit(@Param('id') _id: string) {
    return notImplemented('REQ-04');
  }

  @Post('requests/:id/cancel')
  @Permissions('request.cancel.own')
  cancel(@Param('id') _id: string, @Body() _body: unknown) {
    return notImplemented('REQ-05');
  }

  @Post('requests/:id/complete')
  @Permissions('request.complete')
  complete(@Param('id') _id: string, @Body() _body: unknown) {
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

/** §11.4 request-type administration (screen A2). */
@ApiTags('admin/request-types')
@ApiBearerAuth()
@Controller('admin/request-types')
export class RequestTypesAdminController {
  @Get()
  @Permissions('admin.request-type.manage')
  list() {
    return notImplemented('REQ-01');
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
