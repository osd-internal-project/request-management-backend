import {
  Body,
  Controller,
  Headers,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
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
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentPrincipal, Permissions } from '@request-management/share';
import type { Principal } from '@request-management/share';
import { ContractTermsService } from './contract-terms.service';
import { ContractObligationsService } from './contract-obligations.service';
import {
  ContractAccessDto,
  SaveContractTermsDto,
  SaveObligationDto,
  ListContractsQueryDto,
  SaveLegalContractDto,
} from './dto/legal-contract.dto';
import {
  LegalContractsService,
  MAX_CONTRACT_FILE_BYTES,
} from './legal-contracts.service';

/**
 * CD-161 คลังสัญญา — the Legal screens only. Not in
 * `generate-crm-controllers.py`: it carries multipart uploads, and no
 * integration has been asked to read the repository yet.
 */
@ApiTags('contracts')
@ApiBearerAuth()
@Controller('contracts')
export class LegalContractsController {
  constructor(
    private readonly contracts: LegalContractsService,
    private readonly terms: ContractTermsService,
    private readonly obligations: ContractObligationsService,
  ) {}

  @ApiOperation({ summary: 'ข้อผูกพันของสัญญา (CD-163)' })
  @Get(':id/obligations')
  @Permissions('legal.contract.read')
  listObligations(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.obligations.listForContract(id, principal);
  }

  @ApiOperation({
    summary: 'แตกข้อผูกพันจากสัญญา — มอบให้ผู้รับผิดชอบ (แจ้งเขา)',
  })
  @Post(':id/obligations')
  @Permissions('legal.contract.manage')
  createObligation(
    @Param('id') id: string,
    @Body() dto: SaveObligationDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.obligations.create(id, dto, principal);
  }

  @ApiOperation({ summary: 'แก้ข้อผูกพัน / เปลี่ยนผู้รับผิดชอบ / ยกเว้น' })
  @Patch(':id/obligations/:obligationId')
  @Permissions('legal.contract.manage')
  updateObligation(
    @Param('id') id: string,
    @Param('obligationId') obligationId: string,
    @Body() dto: SaveObligationDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.obligations.update(id, obligationId, dto, principal);
  }

  @ApiOperation({
    summary: 'ข้อกำหนดของสัญญา — ความรับผิด ค่าปรับ การรับประกัน การยกเลิก',
    description:
      'พร้อมค่าที่คำนวณ: ผลอนุมัติเพดานความรับผิด เพดานค่าปรับเป็นเงิน ช่วงประกันนับจากวันตรวจรับ',
  })
  @Get(':id/terms')
  @Permissions('legal.contract.read')
  viewTerms(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.terms.view(id, principal);
  }

  @ApiOperation({
    summary: 'บันทึกข้อกำหนดของสัญญา',
    description:
      'เพดานความรับผิดเกินมูลค่าสัญญา (หรือไม่จำกัด) = สร้าง+ยื่นคำขออนุมัติผู้บริหารตามประเภทที่ตั้งในหน้าตั้งค่า CRM · เปลี่ยนเพดาน = ขออนุมัติใหม่',
  })
  @Put(':id/terms')
  @Permissions('legal.contract.manage')
  saveTerms(
    @Param('id') id: string,
    @Body() dto: SaveContractTermsDto,
    @CurrentPrincipal() principal: Principal,
    @Headers('authorization') authorization: string,
  ) {
    return this.terms.save(id, dto, principal, authorization);
  }

  @ApiOperation({ summary: 'ขออนุมัติเพดานความรับผิดอีกครั้ง' })
  @Post(':id/terms/liability-approval')
  @Permissions('legal.contract.manage')
  requestLiabilityApproval(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
    @Headers('authorization') authorization: string,
  ) {
    return this.terms.requestLiabilityApproval(id, principal, authorization);
  }

  @ApiOperation({
    summary: 'ค้นคลังสัญญา',
    description:
      '`search` = เลขที่/ชื่อ/คู่สัญญา/ลูกค้า/หมายเหตุ · `text` = ข้อความใน PDF ที่แนบ · สัญญาลับพิเศษเห็นเฉพาะผู้มีสิทธิ์',
  })
  @Get()
  @Permissions('legal.contract.read')
  list(
    @Query() query: ListContractsQueryDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.contracts.list(principal, query);
  }

  @ApiOperation({ summary: 'รายละเอียดสัญญา พร้อมไฟล์และผู้เข้าถึง' })
  @Get(':id')
  @Permissions('legal.contract.read')
  detail(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.contracts.detail(id, principal);
  }

  @ApiOperation({ summary: 'บันทึกสัญญา (ลูกค้าในทะเบียน หรือคู่สัญญาอื่น)' })
  @Post()
  @Permissions('legal.contract.manage')
  create(
    @Body() dto: SaveLegalContractDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.contracts.create(dto, principal);
  }

  @ApiOperation({ summary: 'แก้ไขสัญญา' })
  @Patch(':id')
  @Permissions('legal.contract.manage')
  update(
    @Param('id') id: string,
    @Body() dto: SaveLegalContractDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.contracts.update(id, dto, principal);
  }

  @ApiOperation({ summary: 'ตั้งลับพิเศษ และผู้ที่เปิดได้เพิ่มเติม' })
  @Put(':id/access')
  @Permissions('legal.contract.manage')
  setAccess(
    @Param('id') id: string,
    @Body() dto: ContractAccessDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.contracts.setAccess(id, dto, principal);
  }

  @ApiOperation({
    summary: 'แนบไฟล์สัญญา (PDF/Word/รูป ≤ 25 MB) — PDF ดึงข้อความไว้ค้น',
  })
  @Post(':id/documents')
  @Permissions('legal.contract.manage')
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
      limits: { fileSize: MAX_CONTRACT_FILE_BYTES },
      defParamCharset: 'utf8',
    }),
  )
  upload(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.contracts.upload(id, file, principal);
  }

  @ApiOperation({ summary: 'ไฟล์ของสัญญา' })
  @Get(':id/documents/:documentId')
  @Permissions('legal.contract.read')
  async download(
    @Param('id') id: string,
    @Param('documentId') documentId: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<StreamableFile> {
    const file = await this.contracts.download(id, documentId, principal);
    return new StreamableFile(file.stream, {
      type: file.mimeType,
      disposition: `inline; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
    });
  }

  @ApiOperation({ summary: 'ลบไฟล์ของสัญญา' })
  @Delete(':id/documents/:documentId')
  @Permissions('legal.contract.manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeDocument(
    @Param('id') id: string,
    @Param('documentId') documentId: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<void> {
    await this.contracts.removeDocument(id, documentId, principal);
  }
}
