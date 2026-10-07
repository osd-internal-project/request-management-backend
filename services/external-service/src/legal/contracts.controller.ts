import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ActingPermissions,
  CurrentPrincipal,
  Permissions,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import {
  ContractInstallmentsService,
  ContractObligationsService,
  ContractTermsService,
  LegalContractsService,
  ListContractsQueryDto,
} from '@request-management/core-service';
import { ActsForPerson } from '../auth/acts-for-person.decorator';

/**
 * The contract repository (CD-13 Legal) as an outside system follows it —
 * **reads only**.
 *
 * Asking Legal for a contract is a request of the company's contract type
 * (`contractRequestTypeCode` on the deal) raised through
 * `POST request/requests` with `ref_type=opportunity`; drafting, review,
 * approval and signing stay on the screens, where the files are. What a
 * partner needs back is whether the contract exists, its terms, and when it
 * bills — the four reads below, each the screen's own service and
 * `legal.contract.read`, so confidential contracts stay hidden from anyone the
 * screen hides them from.
 */
@ApiTags('legal')
@Controller('legal/contracts')
@ActsForPerson()
export class ExternalContractsController {
  constructor(
    private readonly contracts: LegalContractsService,
    private readonly terms: ContractTermsService,
    private readonly installments: ContractInstallmentsService,
    private readonly obligations: ContractObligationsService,
  ) {}

  @ApiOperation({
    summary: 'ค้นคลังสัญญา',
    description:
      '`opportunity_id` = สัญญาที่เกิดจากดีลนั้น · `search` = เลขที่/ชื่อ/คู่สัญญา · ' +
      'สัญญาลับพิเศษเห็นเฉพาะผู้มีสิทธิ์',
  })
  @Get()
  @Permissions('integration.legal.read')
  @ActingPermissions('legal.contract.read')
  list(
    @Query() query: ListContractsQueryDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.contracts.list(principal, query);
  }

  @ApiOperation({
    summary: 'รายละเอียดสัญญา',
    description:
      'สถานะ วันลงนาม ดีลและคำขอต้นทาง โครงการที่เปิดจากสัญญานี้ และรายชื่อไฟล์ ' +
      '(ตัวไฟล์ดาวน์โหลดจากหน้าเว็บ)',
  })
  @Get(':id')
  @Permissions('integration.legal.read')
  @ActingPermissions('legal.contract.read')
  detail(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.contracts.detail(id, principal);
  }

  @ApiOperation({
    summary: 'ข้อกำหนดของสัญญา — ความรับผิด ค่าปรับ การรับประกัน ระดับบริการ',
  })
  @Get(':id/terms')
  @Permissions('integration.legal.read')
  @ActingPermissions('legal.contract.read')
  viewTerms(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.terms.view(id, principal);
  }

  @ApiOperation({
    summary: 'แผนการวางบิลตามงวด (CD-164)',
    description: 'ทุกงวด พร้อมสัดส่วนต่อมูลค่าสัญญา ผลรวม และส่วนต่าง',
  })
  @Get(':id/installments')
  @Permissions('integration.legal.read')
  @ActingPermissions('legal.contract.read')
  viewInstallments(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.installments.view(id, principal);
  }

  @ApiOperation({ summary: 'ข้อผูกพันของสัญญา (CD-163)' })
  @Get(':id/obligations')
  @Permissions('integration.legal.read')
  @ActingPermissions('legal.contract.read')
  listObligations(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.obligations.listForContract(id, principal);
  }
}
