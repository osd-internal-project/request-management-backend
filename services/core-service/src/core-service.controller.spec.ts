import { Test, TestingModule } from '@nestjs/testing';
import { CoreServiceController } from './core-service.controller';
import { CoreServiceService } from './core-service.service';

describe('CoreServiceController', () => {
  let coreServiceController: CoreServiceController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [CoreServiceController],
      providers: [CoreServiceService],
    }).compile();

    coreServiceController = app.get<CoreServiceController>(
      CoreServiceController,
    );
  });

  describe('root', () => {
    it('should return service status text', () => {
      expect(coreServiceController.getHello()).toContain('core-service');
    });
  });
});
