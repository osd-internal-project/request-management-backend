import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiTags } from '@nestjs/swagger';
import { Permissions, CurrentPrincipal } from '@request-management/share';
import type { Principal } from '@request-management/share';
import { embedDashboardUrl } from './metabase-embed';

interface BiMenuItem {
  key: string;
  title: string;
  embed_url: string;
}

/**
 * CD-92: the BI menu, composed per caller like every other menu (ROLE-06).
 *
 * `report.dashboard.read` gates the endpoint; the Metabase settings link is
 * added only for callers who also hold `admin.bi.manage`. Embed URLs are
 * short-lived signed tokens — sharing one around dies within minutes, and
 * nothing here ever proxies Metabase credentials.
 */
@ApiTags('bi')
@Controller('bi')
export class BiController {
  constructor(private readonly config: ConfigService) {}

  @Get('menu')
  @Permissions('report.dashboard.read')
  menu(@CurrentPrincipal() principal: Principal) {
    const siteUrl = this.config.get<string>('metabase.siteUrl') ?? '';
    const secret = this.config.get<string>('metabase.embedSecret') ?? '';
    const ids = {
      requestOverview:
        this.config.get<number>('metabase.dashboards.requestOverview') ?? 0,
      approval: this.config.get<number>('metabase.dashboards.approval') ?? 0,
      sla: this.config.get<number>('metabase.dashboards.sla') ?? 0,
    };

    const configured = Boolean(siteUrl && secret);
    const titles: Record<keyof typeof ids, string> = {
      requestOverview: 'ภาพรวมคำขอ',
      approval: 'การอนุมัติ',
      sla: 'SLA',
    };

    const dashboards: BiMenuItem[] = configured
      ? (Object.keys(ids) as (keyof typeof ids)[])
          .filter((key) => ids[key] > 0)
          .map((key) => ({
            key,
            title: titles[key],
            embed_url: embedDashboardUrl(siteUrl, secret, ids[key]),
          }))
      : [];

    return {
      configured,
      dashboards,
      // หน้า setting ของ Metabase — โผล่ในเมนูเฉพาะแอดมิน BI
      settings_url: principal.permissions.includes('admin.bi.manage')
        ? siteUrl || null
        : null,
    };
  }
}
