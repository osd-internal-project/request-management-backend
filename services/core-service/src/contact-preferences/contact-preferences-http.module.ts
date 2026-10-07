import { Module } from '@nestjs/common';
import { ContactPreferencesController } from './contact-preferences.controller';
import { ContactPreferencesModule } from './contact-preferences.module';

/** The screen-facing routes of {@link ContactPreferencesModule}. */
@Module({
  imports: [ContactPreferencesModule],
  controllers: [ContactPreferencesController],
})
export class ContactPreferencesHttpModule {}
