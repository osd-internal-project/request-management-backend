import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  type TQueryClient,
} from '@request-management/share';

/** CD-70 ทะเบียนสัญญาของลูกค้า. */
@Injectable()
export class CustomerContractRepository extends BaseRepository<
  PrismaService['customerContract']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.customerContract;
  }
}

/** CD-53 ใบแจ้งหนี้ (SAP) ที่เตือนเลยกำหนดแล้ว ต่อขั้น. */
@Injectable()
export class InvoiceOverdueAlertRepository extends BaseRepository<
  PrismaService['invoiceOverdueAlert']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.invoiceOverdueAlert;
  }
}

/** CD-161 ไฟล์ของสัญญา (PDF ที่ลงนาม ภาคผนวก) พร้อมข้อความที่ดึงไว้ค้น. */
@Injectable()
export class ContractDocumentRepository extends BaseRepository<
  PrismaService['contractDocument']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.contractDocument;
  }
}

/** CD-161 ผู้ที่เปิดสัญญาลับพิเศษได้เพิ่มเติม. */
@Injectable()
export class ContractAccessRepository extends BaseRepository<
  PrismaService['contractAccess']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.contractAccess;
  }
}
