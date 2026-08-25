import { Module } from '@nestjs/common';
import {
  RequestTypesAdminController,
  RequestsController,
} from './requests.controller';

/** S3. Repositories and services land here as the handlers are filled in. */
@Module({
  controllers: [RequestsController, RequestTypesAdminController],
})
export class RequestsModule {}
