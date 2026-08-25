import { Injectable } from '@nestjs/common';

@Injectable()
export class UserServiceService {
  getHello(): string {
    return 'user-service is running.';
  }
}
