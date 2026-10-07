import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  Authenticated,
  CurrentPrincipal,
  Permissions,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import {
  CreateCostCenterDto,
  ListCostCentersQueryDto,
  UpdateCostCenterDto,
} from './cost-centers.dto';
import { CostCentersService } from './cost-centers.service';

@ApiTags('cost-centers')
@ApiBearerAuth()
@Controller('cost-centers')
export class CostCentersController {
  constructor(private readonly costCenters: CostCentersService) {}

  @Get()
  // Anyone filling a form that picks a Cost Center needs the list.
  @Authenticated()
  @ApiOperation({ summary: 'รายการ Cost Center ของบริษัทที่ทำงานอยู่' })
  list(@Query() query: ListCostCentersQueryDto, @CurrentPrincipal() principal: Principal) {
    return this.costCenters.list(principal, query);
  }

  @Post()
  @Permissions('admin.cost-center.manage')
  @ApiOperation({ summary: 'เพิ่ม Cost Center' })
  create(@Body() dto: CreateCostCenterDto, @CurrentPrincipal() principal: Principal) {
    return this.costCenters.create(principal, dto);
  }

  @Patch(':id')
  @Permissions('admin.cost-center.manage')
  @ApiOperation({ summary: 'แก้ชื่อ หน่วยงาน หรือปิดใช้งาน Cost Center (ไม่มีการลบ)' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateCostCenterDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.costCenters.update(principal, id, dto);
  }
}
