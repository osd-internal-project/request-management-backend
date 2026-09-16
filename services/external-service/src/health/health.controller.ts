import { Controller, Get } from '@nestjs/common';
import { Public } from '@request-management/share';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { HealthService, HealthStatus } from './health.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  @Public()
  @ApiOkResponse({ description: 'Service liveness and database reachability.' })
  check(): Promise<HealthStatus> {
    return this.healthService.check();
  }
}
