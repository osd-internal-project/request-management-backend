import { Controller, Get, Param } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ActingPermissions,
  CurrentPrincipal,
  Permissions,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import { ActsForPerson } from '../auth/acts-for-person.decorator';
import { FlowService } from './flow.service';

/**
 * `GET flow/opportunities/{id}` — where a deal is, from the opportunity to
 * the project, and the calls that move it on.
 *
 * A route of this service's own with no screen twin: the screens show the
 * same trail as cards on the deal page, which an integration would otherwise
 * rebuild from six calls. The person's gate is the deal page's,
 * `crm.sales.read`; every section past the deal is read through its own
 * service and its own rules (see `FlowService`).
 */
@ApiTags('flow')
@Controller('flow')
@ActsForPerson()
export class ExternalFlowController {
  constructor(private readonly flow: FlowService) {}

  @ApiOperation({
    summary:
      'ติดตามดีลทั้งสาย — ดีล → Pre-Sales → ใบเสนอราคา → ใบสั่งขาย → สัญญา → โครงการ',
    description:
      '`stage` = ขั้นที่ไปถึงไกลที่สุด · `next_steps` = endpoint ที่ใช้เดินต่อ · ' +
      'ส่วนที่ผู้ใช้ไม่มีสิทธิ์เห็นตอบ `visible: false` พร้อมเหตุผล แทนการล้มทั้งคำตอบ · ' +
      'ดีลที่มองไม่เห็นตอบ 404',
  })
  @Get('opportunities/:id')
  @Permissions('integration.crm.sales.read')
  @ActingPermissions('crm.sales.read')
  track(@Param('id') id: string, @CurrentPrincipal() actor: Principal) {
    return this.flow.track(id, actor);
  }
}
