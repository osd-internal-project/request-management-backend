import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { HealthController } from './health.controller';
import { HealthRepository } from './health.repository';
import { HealthService } from './health.service';

describe('HealthController', () => {
  let healthController: HealthController;
  const healthRepository = { ping: jest.fn() };
  const config = { get: jest.fn().mockReturnValue('core-service') };

  beforeEach(async () => {
    healthRepository.ping.mockReset();

    const app: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        HealthService,
        { provide: HealthRepository, useValue: healthRepository },
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
    });
  });

  it('stays ok but reports the database as down when the ping fails', async () => {
    healthRepository.ping.mockResolvedValue(false);

    await expect(healthController.check()).resolves.toEqual({
      status: 'ok',
      service: 'core-service',
      database: 'down',
    });
  });
});
