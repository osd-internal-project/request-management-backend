import { Body, Controller, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  Authenticated,
  CurrentPrincipal,
  InternalService,
  type Principal,
} from '@request-management/share';
import { IssueRunNumberDto } from './dto/run-number.dto';
import { RunNumberService, type IssueResult } from './run-number.service';

/**
 * ขอเลขรันหนึ่งเลข — เรียกโดย service อื่นเท่านั้น ไม่ผ่าน BFF.
 * สิทธิ์สร้างเอกสารถูกตรวจที่ service ต้นทางแล้ว — docs/run-number.md.
 */
@ApiTags('internal/run-numbers')
@ApiBearerAuth()
@Controller('internal/run-numbers')
export class RunNumberInternalController {
  constructor(private readonly numbers: RunNumberService) {}

  @Post('issue')
  @Authenticated()
  // ผู้เรียกคือ service ในระบบ ระบุบริษัทผ่าน `X-Company-Id`.
  @InternalService()
  issue(
    @Body() dto: IssueRunNumberDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<IssueResult> {
    return this.numbers.issue({
      companyId: principal.activeCompanyId,
      docType: dto.doc_type,
      scopeKey: dto.scope_key?.trim() || '*',
      companyPrefix: dto.company_prefix,
      companyCode: dto.company_code ?? dto.company_prefix,
      at: new Date(),
      master: dto.master,
    });
  }
}
