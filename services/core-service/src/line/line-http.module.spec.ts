import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import {
  AuditWriter,
  PrismaService,
  PrismaTransactionService,
} from '@request-management/share';
import { LineHttpModule } from './line-http.module';
import { LineLinkController } from './line-link.controller';
import { LineSettingsController } from './line-settings.controller';

/** Stand-ins for the app's @Global() providers — only their tokens matter here. */
@Global()
@Module({
  providers: [
    { provide: PrismaService, useValue: {} },
    { provide: PrismaTransactionService, useValue: {} },
    { provide: AuditWriter, useValue: {} },
    { provide: ConfigService, useValue: new ConfigService({}) },
  ],
  exports: [PrismaService, PrismaTransactionService, AuditWriter, ConfigService],
})
class AppGlobals {}

// Unit specs build the services by hand, so only Nest itself shows a provider
// the HTTP module cannot see — the failure that kept rm-core from booting (20 Nov 2026).
describe('LineHttpModule wiring', () => {
  it('resolves both controllers from what LineModule exports', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppGlobals, LineHttpModule],
    }).compile();
    expect(moduleRef.get(LineLinkController)).toBeInstanceOf(LineLinkController);
    expect(moduleRef.get(LineSettingsController)).toBeInstanceOf(
      LineSettingsController,
    );
  });
});
