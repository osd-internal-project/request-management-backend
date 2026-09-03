import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HealthRepository } from './health.repository';
import { FlowableClient } from '../workflow/flowable.client';

export interface HealthStatus {
  status: string;
  service: string;
  database: 'up' | 'down';
  /**
   * The workflow engine.
   *
   * Reported separately because `status: 'ok'` is static and says nothing —
   * the same trap the Prisma outage fell into, where a service with no working
   * database reported healthy right up until the first query. A type running
   * on a workflow cannot move a request while this says `down`.
   */
  workflow: 'up' | 'down';
}

@Injectable()
export class HealthService {
  constructor(
    private readonly healthRepository: HealthRepository,
    private readonly config: ConfigService,
    private readonly flowable: FlowableClient,
  ) {}

  async check(): Promise<HealthStatus> {
    // Both probes at once: a health check that takes as long as its slowest
    // dependency plus its second slowest is a health check that times out.
    const [database, workflow] = await Promise.all([
      this.healthRepository.ping(),
      this.flowable.ping(),
    ]);

    return {
      status: 'ok',
      service: this.config.get<string>('serviceName') ?? 'core-service',
      database: database ? 'up' : 'down',
      workflow: workflow ? 'up' : 'down',
    };
  }
}
