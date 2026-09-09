import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ODOO_CLIENT } from './odoo-client';
import { MockOdooClient } from './mock-odoo.client';
import { HttpOdooClient } from './http-odoo.client';

/**
 * The integration layer's doorway to Odoo (D-30). Pure client — no database
 * access here, so feature modules can import it without a dependency cycle;
 * the queue and the customer-shaped orchestration live with the data they
 * touch (crm/customer-odoo-sync.service.ts).
 */
@Module({
  providers: [
    MockOdooClient,
    HttpOdooClient,
    {
      provide: ODOO_CLIENT,
      inject: [ConfigService, MockOdooClient, HttpOdooClient],
      useFactory: (
        config: ConfigService,
        mock: MockOdooClient,
        http: HttpOdooClient,
      ) => (config.get<string>('odoo.mode') === 'http' ? http : mock),
    },
  ],
  exports: [ODOO_CLIENT],
})
export class OdooModule {}
