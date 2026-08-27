import { Global, Module } from '@nestjs/common';
import { DomainEventsService } from './domain-events.service';

/** Global so any feature can publish without importing a chain of modules. */
@Global()
@Module({
  providers: [DomainEventsService],
  exports: [DomainEventsService],
})
export class EventsModule {}
