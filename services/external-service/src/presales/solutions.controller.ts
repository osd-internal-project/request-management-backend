import { Controller, Get, Param, ParseIntPipe } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ActingPermissions,
  CurrentPrincipal,
  Permissions,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import {
  ProposalService,
  SolutionQuotationService,
  SolutionsService,
} from '@request-management/core-service';
import { ActsForPerson } from '../auth/acts-for-person.decorator';

/**
 * Pre-Sales as an outside system follows it — **reads only**.
 *
 * Starting Pre-Sales is not here, and needs no route of its own: a deal asks
 * for a solution by raising a request of the company's solution type
 * (`solutionRequestTypeCode` on `GET crm/opportunities/{id}`) with
 * `ref_type=opportunity`, through `POST request/requests`. Designing the
 * Solution stays on the screens — `SolutionsController` in core-service says
 * why: a partner system has no design to send.
 *
 * Each route answers what its screen twin answers. `@Authenticated()` screen
 * routes become `notification.read` here — the permission every role holds,
 * standing for "a signed-in person" — and `SolutionsService` still decides
 * which Solutions that person may read (Pre-Sales all, a salesperson only
 * those on deals they see). `downstream-route-parity.spec.ts` holds the pairs.
 */
@ApiTags('presales')
@Controller('presales')
@ActsForPerson()
export class ExternalSolutionsController {
  constructor(
    private readonly solutions: SolutionsService,
    private readonly proposals: ProposalService,
    private readonly quotations: SolutionQuotationService,
  ) {}

  @ApiOperation({
    summary: 'Solution ทั้งหมดของดีล',
    description:
      'แต่ละใบพร้อมเวอร์ชัน สถานะอนุมัติ และจำนวนความต้องการ/ประเด็นที่ค้าง — ' +
      'ดีลที่มองไม่เห็นตอบ 404',
  })
  @Get('opportunities/:id/solutions')
  @Permissions('integration.crm.sales.read')
  @ActingPermissions('crm.sales.read')
  forDeal(@Param('id') id: string, @CurrentPrincipal() actor: Principal) {
    return this.solutions.forDeal(id, actor);
  }

  @ApiOperation({
    summary: 'Solution พร้อมเวอร์ชันล่าสุด',
    description:
      'ความต้องการ ประเด็นชี้แจง ความเสี่ยง Demo/POC TOR และเวอร์ชันปัจจุบัน ' +
      '(ขอบเขต สมมติฐาน BOQ) — อัตราค่าแรงเห็นเฉพาะผู้ถือ hr.rate.read',
  })
  @Get('solutions/:id')
  @Permissions('integration.presales.solution.read')
  @ActingPermissions('notification.read')
  findOne(@Param('id') id: string, @CurrentPrincipal() actor: Principal) {
    return this.solutions.findOne(id, actor);
  }

  @ApiOperation({ summary: 'Solution ที่เวอร์ชันที่ระบุ' })
  @Get('solutions/:id/versions/:no')
  @Permissions('integration.presales.solution.read')
  @ActingPermissions('notification.read')
  version(
    @Param('id') id: string,
    @Param('no', ParseIntPipe) no: number,
    @CurrentPrincipal() actor: Principal,
  ) {
    return this.solutions.findOne(id, actor, no);
  }

  @ApiOperation({
    summary: 'ข้อเสนอทางเทคนิค (CD-137)',
    description:
      'เฉพาะเวอร์ชันที่อนุมัติแล้ว ไม่มีต้นทุน — ฉบับที่ส่งให้ลูกค้าได้',
  })
  @Get('solutions/:id/versions/:no/proposal')
  @Permissions('integration.presales.solution.read')
  @ActingPermissions('notification.read')
  proposal(
    @Param('id') id: string,
    @Param('no', ParseIntPipe) no: number,
    @CurrentPrincipal() actor: Principal,
  ) {
    return this.proposals.printView(id, no, actor);
  }

  @ApiOperation({
    summary: 'ใบเสนอราคาที่สร้างจาก Solution นี้ (CD-198)',
    description:
      'เลขที่ เวอร์ชัน สถานะ และยอดสุทธิ — รายละเอียดเต็มที่ ' +
      '`GET crm/quotations/{id}`',
  })
  @Get('solutions/:id/quotations')
  @Permissions('integration.presales.solution.read')
  @ActingPermissions('notification.read')
  quotationsOf(@Param('id') id: string, @CurrentPrincipal() actor: Principal) {
    return this.quotations.forSolution(id, actor);
  }
}
