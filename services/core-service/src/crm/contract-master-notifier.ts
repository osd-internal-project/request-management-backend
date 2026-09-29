import { Injectable, Logger } from '@nestjs/common';
import type { Principal } from '@request-management/share';
import { NotificationsService } from '../notifications/notifications.service';
import { CustomerContractRepository } from './contract.repositories';

/**
 * CD-149 — "แก้ข้อตกลงหลักจะแจ้งเตือนทุกสัญญาย่อยที่ยังมีผล": when an MSA's
 * details, terms or files change, the owner of every active contract made
 * under it hears which change, once per contract. The person who made the
 * change is not told about their own edit. Never fails the edit itself.
 */
@Injectable()
export class ContractMasterNotifier {
  private readonly logger = new Logger(ContractMasterNotifier.name);

  constructor(
    private readonly contracts: CustomerContractRepository,
    private readonly notifications: NotificationsService,
  ) {}

  async changed(
    masterId: string,
    change: string,
    actor: Principal,
  ): Promise<number> {
    try {
      const master = (await this.contracts.findFirst({
        where: { id: masterId, kind: 'msa' },
        select: {
          companyId: true,
          contractNo: true,
          title: true,
          subContracts: {
            where: { status: 'active' },
            select: { id: true, contractNo: true, ownerUserId: true },
          },
        },
      })) as {
        companyId: string;
        contractNo: string;
        title: string;
        subContracts: { id: string; contractNo: string; ownerUserId: string }[];
      } | null;
      if (!master) return 0;
      let told = 0;
      for (const sub of master.subContracts) {
        if (sub.ownerUserId === actor.userId) continue;
        await this.notifications.masterAgreementChanged(
          sub.ownerUserId,
          master.companyId,
          master,
          sub,
          change,
        );
        told += 1;
      }
      return told;
    } catch (error) {
      this.logger.warn(
        `CD-149: telling sub-contracts of ${masterId}: ${(error as Error).message}`,
      );
      return 0;
    }
  }
}
