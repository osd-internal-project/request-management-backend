import { Injectable } from '@nestjs/common';
import {
  AppError,
  Principal,
  salesAccessSubject,
  visibleSalesWhere,
} from '@request-management/share';
import { CompanyMemberRepository } from '../access/company-member.repository';
import { QuotationRepository } from './sales.repositories';
import { CrmConfigRepository } from './segment.repositories';

export interface PrintRow {
  id: string;
  quotationNo: string;
  version: number;
  status: string;
  title: string;
  currency: string;
  validUntil: Date | null;
  paymentTerms: string | null;
  note: string | null;
  partyName: string;
  partyTaxId: string | null;
  contactName: string | null;
  subtotal: unknown;
  discountTotal: unknown;
  netTotal: unknown;
  vatPct: unknown;
  vatAmount: unknown;
  grandTotal: unknown;
  createdAt: Date;
  sentAt: Date | null;
  ownerUserId: string;
  companyId: string;
  company: { name: string };
  customer: {
    customerCode: string;
    nameTh: string;
    taxId: string | null;
    branchCode: string;
    branchName: string | null;
    locations: {
      line1: string;
      line2: string | null;
      subDistrict: string | null;
      district: string | null;
      province: string | null;
      postalCode: string | null;
    }[];
  } | null;
  lines: {
    lineNo: number;
    productCode: string | null;
    description: string;
    quantity: unknown;
    unit: string | null;
    unitPrice: unknown;
    discountPct: unknown;
    lineTotal: unknown;
  }[];
}

/**
 * ใบเสนอราคาฉบับส่งลูกค้า — ข้อมูลที่พิมพ์ลงเอกสารเท่านั้น.
 *
 * **ไม่มีต้นทุนและ margin เลย** ไม่ว่าผู้เรียกจะมีสิทธิ์เห็นหรือไม่: เอกสารนี้
 * ออกไปถึงลูกค้า การตัดทิ้งที่ query ปลอดภัยกว่าการพึ่ง masking ตามสิทธิ์ ซึ่ง
 * ผู้จัดการที่เห็นต้นทุนได้จะพิมพ์ต้นทุนติดออกไปด้วย.
 *
 * หัวกระดาษมาจาก `crm_company_configs` — อ่านได้ด้วย `crm.sales.read` ผ่าน
 * endpoint นี้ ไม่ต้องมีสิทธิ์ admin เหมือนหน้าตั้งค่า.
 */
@Injectable()
export class QuotationPrintService {
  constructor(
    private readonly quotations: QuotationRepository,
    private readonly configs: CrmConfigRepository,
    private readonly members: CompanyMemberRepository,
  ) {}

  async printView(id: string, actor: Principal) {
    const found = (await this.quotations.findFirst({
      where: { id, AND: [visibleSalesWhere(salesAccessSubject(actor))] },
      select: {
        id: true,
        quotationNo: true,
        version: true,
        status: true,
        title: true,
        currency: true,
        validUntil: true,
        paymentTerms: true,
        note: true,
        partyName: true,
        partyTaxId: true,
        contactName: true,
        subtotal: true,
        discountTotal: true,
        netTotal: true,
        vatPct: true,
        vatAmount: true,
        grandTotal: true,
        createdAt: true,
        sentAt: true,
        ownerUserId: true,
        companyId: true,
        company: { select: { name: true } },
        customer: {
          select: {
            customerCode: true,
            nameTh: true,
            taxId: true,
            branchCode: true,
            branchName: true,
            // ที่อยู่ออกใบกำกับ ถ้ามีหลายแห่งเอาที่เป็นหลักก่อน
            locations: {
              where: { active: true, isBilling: true },
              orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
              take: 1,
              select: {
                line1: true,
                line2: true,
                subDistrict: true,
                district: true,
                province: true,
                postalCode: true,
              },
            },
          },
        },
        lines: {
          orderBy: { lineNo: 'asc' },
          select: {
            lineNo: true,
            productCode: true,
            description: true,
            quantity: true,
            unit: true,
            unitPrice: true,
            discountPct: true,
            lineTotal: true,
          },
        },
      },
    })) as PrintRow | null;

    // SCOPE-03: unseen = 404.
    if (!found) throw new AppError('NOT_FOUND', 'ไม่พบใบเสนอราคาที่ระบุ');

    const [config, sellers] = await Promise.all([
      this.configs.findFirst({
        where: { companyId: found.companyId },
      }) as Promise<Record<string, string | null> | null>,
      this.members.findMany({
        where: { id: { in: [found.ownerUserId] } },
        select: { id: true, displayName: true, email: true },
      }) as Promise<{ displayName: string; email: string | null }[]>,
    ]);

    const { company, customer } = found;
    const billing = customer?.locations[0] ?? null;
    // Internal keys stay out of the printed payload.
    const quotation: Partial<PrintRow> = { ...found };
    delete quotation.company;
    delete quotation.customer;
    delete quotation.ownerUserId;
    delete quotation.companyId;

    return {
      quotation,
      /** ผู้ซื้อ — ลูกค้าในทะเบียนถ้าผูกแล้ว ไม่งั้นชื่อผู้มุ่งหวังที่อยู่บนใบ. */
      billTo: {
        name: customer?.nameTh ?? found.partyName,
        customerCode: customer?.customerCode ?? null,
        taxId: customer?.taxId ?? found.partyTaxId,
        branch: customer
          ? customer.branchCode === '00000'
            ? 'สำนักงานใหญ่'
            : (customer.branchName ?? `สาขาที่ ${customer.branchCode}`)
          : null,
        address: billing
          ? [
              billing.line1,
              billing.line2,
              billing.subDistrict,
              billing.district,
              billing.province,
              billing.postalCode,
            ]
              .filter(Boolean)
              .join(' ')
          : null,
        contactName: found.contactName,
      },
      seller: sellers[0]
        ? { name: sellers[0].displayName, email: sellers[0].email }
        : null,
      letterhead: {
        nameTh: config?.letterheadNameTh ?? company.name,
        nameEn: config?.letterheadNameEn ?? null,
        taxId: config?.letterheadTaxId ?? null,
        branch: config?.letterheadBranch ?? null,
        address: config?.letterheadAddress ?? null,
        phone: config?.letterheadPhone ?? null,
        email: config?.letterheadEmail ?? null,
        website: config?.letterheadWebsite ?? null,
        logo: config?.letterheadLogo ?? null,
        terms: config?.quotationTerms ?? null,
      },
      /** ใช้กำหนดลายน้ำ "ร่าง" — ยังไม่ผ่านขั้นที่ส่งลูกค้าได้. */
      isFinal: ['approved', 'sent', 'accepted'].includes(found.status),
    };
  }
}
