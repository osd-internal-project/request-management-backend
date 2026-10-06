import { Controller, Get, Param } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ActingPermissions,
  CurrentPrincipal,
  Permissions,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import {
  DeliveriesService,
  InstallmentBillingService,
  ServiceHandoversService,
} from '@request-management/core-service';
import { ActsForPerson } from '../auth/acts-for-person.decorator';

/**
 * Delivery (CD-20) of one project, from outside — **reads only**: the
 * delivery plan, the billing of each installment, and the hand-over to the
 * service team. Confirming installation, certificates and sending a bill
 * stay on the screens (they sign documents and move money in SAP).
 *
 * The screen routes are `@Authenticated()` and the services judge the person
 * (project manager, team, Delivery, finance), so the person's gate here is
 * `notification.read` — "signed in" — and the service still answers 404 for a
 * project they cannot see.
 */
@ApiTags('delivery')
@Controller('delivery/projects/:projectId')
@ActsForPerson()
export class ExternalDeliveryController {
  constructor(
    private readonly deliveries: DeliveriesService,
    private readonly billing: InstallmentBillingService,
    private readonly handovers: ServiceHandoversService,
  ) {}

  @ApiOperation({
    summary: 'แผนส่งมอบของโครงการ (CD-250)',
    description: 'รอบส่ง หมุดหมาย และ BOQ ที่วางแผนแล้ว',
  })
  @Get()
  @Permissions('integration.delivery.read')
  @ActingPermissions('notification.read')
  project(
    @Param('projectId') projectId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.deliveries.project(principal, projectId);
  }

  @ApiOperation({
    summary: 'งวดของสัญญา: สถานะวางบิล/SAP และสิ่งที่ยังขวาง (CD-253)',
  })
  @Get('billing')
  @Permissions('integration.delivery.read')
  @ActingPermissions('notification.read')
  billingView(
    @Param('projectId') projectId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.billing.view(principal, projectId);
  }

  @ApiOperation({
    summary: 'รอบตรวจรับที่ส่งต่อให้ทีมบริการ และสถานะการรับทราบ (CD-255)',
  })
  @Get('handovers')
  @Permissions('integration.delivery.read')
  @ActingPermissions('notification.read')
  handoversOfProject(
    @Param('projectId') projectId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.handovers.projectView(principal, projectId);
  }
}
