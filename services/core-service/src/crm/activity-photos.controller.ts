import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentPrincipal, Permissions } from '@request-management/share';
import type { Principal } from '@request-management/share';
import {
  ActivityPhotosService,
  MAX_PHOTO_BYTES,
} from './activity-photos.service';

/**
 * CD-75 — photos on a deal's activities, for the screens only.
 *
 * Its own controller, and deliberately **not** in `generate-crm-controllers.py`:
 * a partner system has no visit photos to send, and the generator's rewritten
 * import block does not carry the multipart decorators.
 */
@ApiTags('opportunities')
@ApiBearerAuth()
@Controller('opportunities')
export class ActivityPhotosController {
  constructor(private readonly photos: ActivityPhotosService) {}

  @ApiOperation({
    summary: 'แนบรูปกับกิจกรรม (JPEG/PNG/WebP/HEIC ≤ 15 MB, ≤ 10 รูป)',
  })
  @Post(':id/activities/:activityId/photos')
  @Permissions('crm.sales.manage')
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_PHOTO_BYTES },
      defParamCharset: 'utf8',
    }),
  )
  upload(
    @Param('id') id: string,
    @Param('activityId') activityId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.photos.upload(id, activityId, file, principal);
  }

  @ApiOperation({ summary: 'ไฟล์รูปของกิจกรรม' })
  @Get(':id/activities/:activityId/photos/:photoId')
  @Permissions('crm.sales.read')
  async download(
    @Param('id') id: string,
    @Param('activityId') activityId: string,
    @Param('photoId') photoId: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<StreamableFile> {
    const { photo, stream } = await this.photos.download(
      id,
      activityId,
      photoId,
      principal,
    );
    return new StreamableFile(stream, {
      type: photo.mimeType,
      length: photo.sizeBytes,
      disposition: `inline; filename*=UTF-8''${encodeURIComponent(photo.fileName)}`,
    });
  }

  @ApiOperation({ summary: 'ลบรูป (เฉพาะคนที่แนบ)' })
  @Delete(':id/activities/:activityId/photos/:photoId')
  @Permissions('crm.sales.manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id') id: string,
    @Param('activityId') activityId: string,
    @Param('photoId') photoId: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<void> {
    await this.photos.remove(id, activityId, photoId, principal);
  }
}
