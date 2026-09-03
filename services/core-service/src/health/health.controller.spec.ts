import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { HealthController } from './health.controller';
import { HealthRepository } from './health.repository';
import { HealthService } from './health.service';
import { FlowableClient } from '../workflow/flowable.client';

describe('HealthController', () => {
  let healthController: HealthController;
  const healthRepository = { ping: jest.fn() };
  const flowable = { ping: jest.fn() };
  const config = { get: jest.fn().mockReturnValue('core-service') };

  beforeEach(async () => {
    healthRepository.ping.mockReset();
    flowable.ping.mockReset().mockResolvedValue(true);

    const app: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        HealthService,
        { provide: HealthRepository, useValue: healthRepository },
        { provide: FlowableClient, useValue: flowable },
        { provide: ConfigService, useValue: config },
      ],
    }).compile();

    healthController = app.get<HealthController>(HealthController);
  });

  it('reports the database as up when the ping succeeds', async () => {
    healthRepository.ping.mockResolvedValue(true);

    await expect(healthController.check()).resolves.toEqual({
      status: 'ok',
      service: 'core-service',
      database: 'up',
      workflow: 'up',
    });
  });

  it('stays ok but reports the database as down when the ping fails', async () => {
    healthRepository.ping.mockResolvedValue(false);

    await expect(healthController.check()).resolves.toEqual({
      status: 'ok',
      service: 'core-service',
      database: 'down',
      workflow: 'up',
    });
  });

  /**
   * The engine being down must be visible here. `status` is static and says
   * `ok` either way — the same trap that hid the Prisma outage, where a
   * service with no working database reported healthy until the first query.
   */
  it('reports the workflow engine as down without failing the check', async () => {
    healthRepository.ping.mockResolvedValue(true);
    flowable.ping.mockResolvedValue(false);

    await expect(healthController.check()).resolves.toEqual({
      status: 'ok',
      service: 'core-service',
      database: 'up',
      workflow: 'down',
    });
  });
});
