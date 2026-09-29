import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentPrincipal, Permissions } from '@request-management/share';
import type { Principal } from '@request-management/share';
import { ContractObligationsService } from './contract-obligations.service';
import { CompleteObligationDto } from './dto/legal-contract.dto';

/**
 * CD-163 — ข้อผูกพันของฉัน, for whoever an obligation was handed to — often
 * not in Legal, so these ask only for a signed-in person (`notification.read`,
 * which every role holds); the service checks the obligation is theirs.
 */
@ApiTags('contracts')
@ApiBearerAuth()
@Controller('contract-obligations')
export class ContractObligationsController {
  constructor(private readonly obligations: ContractObligationsService) {}

  @ApiOperation({ summary: 'ข้อผูกพันตามสัญญาที่ฉันรับผิดชอบ' })
  @Get('mine')
  @Permissions('notification.read')
  mine(@CurrentPrincipal() principal: Principal) {
    return this.obligations.mine(principal);
  }

  @ApiOperation({
    summary: 'บันทึกว่าทำข้อผูกพันแล้ว (เจ้าของ หรือฝ่ายกฎหมาย)',
  })
  @Post(':id/done')
  @Permissions('notification.read')
  done(
    @Param('id') id: string,
    @Body() dto: CompleteObligationDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.obligations.complete(id, dto, principal);
  }
}
