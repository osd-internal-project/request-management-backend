import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '@request-management/share';
import { UserServiceService } from './user-service.service';

@ApiTags('health')
@Controller()
export class UserServiceController {
  constructor(private readonly userServiceService: UserServiceService) {}

  @Get()
  @Public()
  getHello(): string {
    return this.userServiceService.getHello();
  }

  @Get('health')
  @Public()
  getHealth(): { status: string; service: string } {
    return { status: 'ok', service: 'user-service' };
  }
}
