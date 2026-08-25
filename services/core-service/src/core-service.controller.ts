import { Controller, Get } from '@nestjs/common';
import { Public } from '@request-management/share';
import { ApiExcludeEndpoint } from '@nestjs/swagger';
import { CoreServiceService } from './core-service.service';

@Controller()
export class CoreServiceController {
  constructor(private readonly coreServiceService: CoreServiceService) {}

  @Get()
  @Public()
  @ApiExcludeEndpoint()
  getHello(): string {
    return this.coreServiceService.getHello();
  }
}
