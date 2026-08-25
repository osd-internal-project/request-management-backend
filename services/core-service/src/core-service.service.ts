import { Injectable } from '@nestjs/common';

@Injectable()
export class CoreServiceService {
  getHello(): string {
    return 'core-service is running. No business logic yet.';
  }
}
