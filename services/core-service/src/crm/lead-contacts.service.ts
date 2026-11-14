import { Injectable } from '@nestjs/common';
import {
  AppError,
  AuditWriter,
  auditActor,
  Principal,
  PrismaTransactionService,
  TQueryClient,
} from '@request-management/share';
import { DomainEventsService } from '../events/domain-events.service';
import { LeadsService, leadEvent } from './leads.service';
import { LeadContactRepository, LeadRepository } from './sales.repositories';
import { LeadContactDto } from './dto/sales.dto';
import {
  PRIMARY_CONTACT_ID,
  contactsOf,
  hasPrimaryContact,
  type LeadContactRow,
  type LeadPrimaryColumns,
} from './lead-contact-rules';

type OpenLead = Awaited<ReturnType<LeadsService['requireOpen']>>;

/** The four `leads` columns a contact's values go into. */
function primaryColumns(dto: LeadContactDto): LeadPrimaryColumns {
  return {
    contactName: dto.name.trim(),
    contactPosition: dto.position?.trim() || null,
    phone: dto.phone?.trim() || null,
    email: dto.email?.trim() || null,
  };
}

/** The same values as an extra contact's row. */
function rowColumns(dto: LeadContactDto) {
  return {
    name: dto.name.trim(),
    position: dto.position?.trim() || null,
    phone: dto.phone?.trim() || null,
    email: dto.email?.trim() || null,
  };
}

/**
 * ผู้ติดต่อของ Lead ได้หลายคน (12 พ.ย. 2569).
 *
 * ผู้ติดต่อ **หลัก** คือสี่คอลัมน์บน `leads` เหมือนเดิม — อีเมลขาย ใบเสนอราคา
 * intake และ API ภายนอกอ่านจากตรงนั้น และไม่มีที่ไหนต้องแก้. คนที่สองเป็นต้นไป
 * อยู่ใน `lead_contacts`. ตั้งคนอื่นเป็นหลัก = สลับค่ากับ `leads` ใน transaction
 * เดียว จึงไม่มีข้อมูลชุดเดียวกันสองที่.
 *
 * id ของผู้ติดต่อหลักคือคำว่า `primary` — ไม่มีแถวของมันเอง.
 */
@Injectable()
export class LeadContactsService {
  constructor(
    private readonly leadsService: LeadsService,
    private readonly leads: LeadRepository,
    private readonly contacts: LeadContactRepository,
    private readonly transactions: PrismaTransactionService,
    private readonly audit: AuditWriter,
    private readonly events: DomainEventsService,
  ) {}

  async add(leadId: string, dto: LeadContactDto, actor: Principal) {
    const lead = await this.leadsService.requireOpen(leadId, actor);

    await this.transactions.execute(async (prisma) => {
      if (!hasPrimaryContact(lead)) {
        // คนแรกของใบ = ผู้ติดต่อหลัก
        await this.writePrimary(lead.id, primaryColumns(dto), actor, prisma);
      } else if (dto.is_primary) {
        await this.demotePrimary(lead, actor, prisma);
        await this.writePrimary(lead.id, primaryColumns(dto), actor, prisma);
      } else {
        await this.contacts.create(
          {
            data: {
              companyId: actor.activeCompanyId,
              leadId: lead.id,
              ...rowColumns(dto),
              createdBy: actor.userId,
            },
          },
          { prisma },
        );
      }

      await this.record('crm.lead.contact_added', lead.id, actor, prisma, {
        name: dto.name.trim(),
        isPrimary: !hasPrimaryContact(lead) || dto.is_primary === true,
      });
    });

    return this.finish(lead, actor);
  }

  async update(
    leadId: string,
    contactId: string,
    dto: LeadContactDto,
    actor: Principal,
  ) {
    const lead = await this.leadsService.requireOpen(leadId, actor);

    if (contactId === PRIMARY_CONTACT_ID) {
      if (!hasPrimaryContact(lead)) throw notFound();

      await this.transactions.execute(async (prisma) => {
        await this.writePrimary(lead.id, primaryColumns(dto), actor, prisma);
        await this.record('crm.lead.contact_updated', lead.id, actor, prisma, {
          contactId,
          name: dto.name.trim(),
        });
      });

      return this.finish(lead, actor);
    }

    await this.requireRow(lead.id, contactId);

    await this.transactions.execute(async (prisma) => {
      if (dto.is_primary) {
        // สลับ: แถวนี้รับค่าของผู้ติดต่อหลักเดิม แล้วค่าใหม่ขึ้นไปอยู่บน Lead
        if (hasPrimaryContact(lead)) {
          await this.contacts.update(
            {
              where: { id: contactId },
              data: {
                name: lead.contactName?.trim() || lead.name,
                position: lead.contactPosition,
                phone: lead.phone,
                email: lead.email,
                updatedBy: actor.userId,
              },
            },
            { prisma },
          );
        } else {
          await this.contacts.update(
            {
              where: { id: contactId },
              data: { active: false, updatedBy: actor.userId },
            },
            { prisma },
          );
        }
        await this.writePrimary(lead.id, primaryColumns(dto), actor, prisma);
      } else {
        await this.contacts.update(
          {
            where: { id: contactId },
            data: { ...rowColumns(dto), updatedBy: actor.userId },
          },
          { prisma },
        );
      }

      await this.record(
        dto.is_primary
          ? 'crm.lead.contact_primary_changed'
          : 'crm.lead.contact_updated',
        lead.id,
        actor,
        prisma,
        { contactId, name: dto.name.trim() },
      );
    });

    return this.finish(lead, actor);
  }

  /**
   * ลบ = soft delete. ลบผู้ติดต่อหลัก: คนที่เพิ่มไว้ก่อนสุดขึ้นมาเป็นหลักแทน;
   * ถ้าไม่มีใครเหลือ สี่คอลัมน์บน Lead ว่าง.
   */
  async remove(leadId: string, contactId: string, actor: Principal) {
    const lead = await this.leadsService.requireOpen(leadId, actor);

    if (contactId === PRIMARY_CONTACT_ID) {
      if (!hasPrimaryContact(lead)) throw notFound();

      const next = (await this.contacts.findFirst({
        where: { leadId: lead.id, active: true },
        orderBy: { createdAt: 'asc' },
      })) as LeadContactRow | null;

      await this.transactions.execute(async (prisma) => {
        if (next) {
          await this.contacts.update(
            {
              where: { id: next.id },
              data: { active: false, updatedBy: actor.userId },
            },
            { prisma },
          );
        }
        await this.writePrimary(
          lead.id,
          {
            contactName: next?.name ?? null,
            contactPosition: next?.position ?? null,
            phone: next?.phone ?? null,
            email: next?.email ?? null,
          },
          actor,
          prisma,
        );
        await this.record('crm.lead.contact_removed', lead.id, actor, prisma, {
          contactId,
          name: lead.contactName,
          promoted: next?.name ?? null,
        });
      });

      return this.finish(lead, actor);
    }

    const row = await this.requireRow(lead.id, contactId);

    await this.transactions.execute(async (prisma) => {
      await this.contacts.update(
        {
          where: { id: contactId },
          data: { active: false, updatedBy: actor.userId },
        },
        { prisma },
      );
      await this.record('crm.lead.contact_removed', lead.id, actor, prisma, {
        contactId,
        name: row.name,
      });
    });

    return this.finish(lead, actor);
  }

  /** ผู้ติดต่อหลักเดิมลงมาเป็นแถวใน `lead_contacts`. */
  private async demotePrimary(
    lead: OpenLead,
    actor: Principal,
    prisma: TQueryClient,
  ) {
    await this.contacts.create(
      {
        data: {
          companyId: actor.activeCompanyId,
          leadId: lead.id,
          name: lead.contactName?.trim() || lead.name,
          position: lead.contactPosition,
          phone: lead.phone,
          email: lead.email,
          createdBy: actor.userId,
        },
      },
      { prisma },
    );
  }

  private async writePrimary(
    leadId: string,
    columns: LeadPrimaryColumns,
    actor: Principal,
    prisma: TQueryClient,
  ) {
    await this.leads.update(
      { where: { id: leadId }, data: { ...columns, updatedBy: actor.userId } },
      { prisma },
    );
  }

  private async requireRow(leadId: string, contactId: string) {
    const row = (await this.contacts.findFirst({
      where: { id: contactId, leadId, active: true },
    })) as LeadContactRow | null;

    if (!row) throw notFound();
    return row;
  }

  /** Names only — phone and email stay out of the audit log. */
  private record(
    eventType: string,
    leadId: string,
    actor: Principal,
    prisma: TQueryClient,
    after: Record<string, string | boolean | null>,
  ) {
    return this.audit.record(
      {
        eventType,
        companyId: actor.activeCompanyId,
        ...auditActor(actor),
        resourceType: 'lead',
        resourceId: leadId,
        after,
      },
      { prisma },
    );
  }

  /** After commit: tell listeners the lead changed, answer the list as it now stands. */
  private async finish(lead: OpenLead, actor: Principal) {
    await this.events.emit({
      name: 'lead.updated',
      payload: leadEvent(actor.activeCompanyId, lead, {
        changed_fields: ['contacts'],
      }),
    });

    const [fresh, rows] = await Promise.all([
      this.leads.findFirst({
        where: { id: lead.id },
        select: {
          contactName: true,
          contactPosition: true,
          phone: true,
          email: true,
        },
      }) as Promise<LeadPrimaryColumns>,
      this.contacts.findMany({
        where: { leadId: lead.id, active: true },
        orderBy: { createdAt: 'asc' },
      }) as Promise<LeadContactRow[]>,
    ]);

    return contactsOf(fresh, rows);
  }
}

function notFound() {
  return new AppError('NOT_FOUND', 'ไม่พบผู้ติดต่อที่ระบุ');
}
