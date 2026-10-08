import { Module } from '@nestjs/common';
import { DoNotContactRepository } from './contact-preferences.repositories';
import { DoNotContactService } from './do-not-contact.service';

/**
 * CD-291 — who may not be contacted. AI SMART checks it before every call;
 * AI CARE before a message. Stands in for the PDPA central system's register.
 */
@Module({
  providers: [DoNotContactRepository, DoNotContactService],
  exports: [DoNotContactService],
})
export class ContactPreferencesModule {}
