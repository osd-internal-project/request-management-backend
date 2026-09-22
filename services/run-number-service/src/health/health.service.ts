import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HealthRepository } from './health.repository';

export interface HealthStatus {
  status: string;
  service: string;
  database: 'up' | 'down';
}

@Injectable()
export class HealthService {
  constructor(
    private readonly healthRepository: HealthRepository,
    private readonly config: ConfigService,
  ) {}

  async check(): Promise<HealthStatus> {
    const reachable = await this.healthRepository.ping();

    return {
      status: 'ok',
      service: this.config.get<string>('serviceName') ?? 'run-number-service',
      database: reachable ? 'up' : 'down',
    };
  }
}
