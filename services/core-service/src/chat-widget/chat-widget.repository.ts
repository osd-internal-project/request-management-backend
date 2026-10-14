import { Injectable } from '@nestjs/common';
import type { ChatWidgetGroup, ChatWidgetSetting } from '@prisma/client';
import {
  BaseRepository,
  PrismaService,
  TQueryClient,
  TxOption,
} from '@request-management/share';

export type WidgetWithGroups = ChatWidgetSetting & {
  groups: Pick<ChatWidgetGroup, 'orgUnitId' | 'isDefault'>[];
};

/** Every `chat_widget_settings` / `chat_widget_groups` query lives here. */
@Injectable()
export class ChatWidgetSettingRepository extends BaseRepository<
  PrismaService['chatWidgetSetting']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.chatWidgetSetting;
  }

  /** The user's unit and every unit above it, with how far up each one is. */
  async ancestorDepths(orgUnitId: string | null): Promise<Map<string, number>> {
    if (!orgUnitId) return new Map();
    const rows = await this.prisma.orgClosure.findMany({
      where: { descendantId: orgUnitId },
      select: { ancestorId: true, depth: true },
    });
    return new Map(rows.map((row) => [row.ancestorId, row.depth]));
  }

  /**
   * Active widgets a member of those units may open: org-wide ones, plus the
   * ones added to any of them. Each carries only the group rows that matched.
   */
  findVisible(
    companyId: string,
    ancestorIds: readonly string[],
  ): Promise<WidgetWithGroups[]> {
    const inUnits = { orgUnitId: { in: [...ancestorIds] } };
    return this.prisma.chatWidgetSetting.findMany({
      where: {
        companyId,
        active: true,
        OR: [
          { orgWide: true },
          ...(ancestorIds.length ? [{ groups: { some: inUnits } }] : []),
        ],
      },
      include: {
        groups: {
          where: inUnits,
          select: { orgUnitId: true, isDefault: true },
        },
      },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
  }

  /** Every widget of the company, inactive included — the admin list. */
  findForCompany(companyId: string) {
    return this.prisma.chatWidgetSetting.findMany({
      where: { companyId },
      include: { _count: { select: { groups: true } } },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
  }

  /** Clears the org default of every other widget. Call inside the write. */
  clearOrgDefault(companyId: string, exceptId: string, option: TxOption) {
    const client = option.prisma ?? this.prisma;
    return client.chatWidgetSetting.updateMany({
      where: { companyId, isDefault: true, id: { not: exceptId } },
      data: { isDefault: false },
    });
  }

  /** The company's active units with how many active chats each was given. */
  companyUnits(companyId: string) {
    return this.prisma.orgUnit.findMany({
      where: { companyId, active: true },
      select: {
        id: true,
        name: true,
        kind: true,
        parentId: true,
        _count: {
          select: { chatWidgets: { where: { widget: { active: true } } } },
        },
      },
      orderBy: { name: 'asc' },
    });
  }

  findUnit(companyId: string, orgUnitId: string) {
    return this.prisma.orgUnit.findFirst({
      where: { id: orgUnitId, companyId, active: true },
      select: { id: true, name: true },
    });
  }

  /** The unit's rows whose widget is active — what the group screen edits. */
  activeGroupRows(orgUnitId: string, option?: TxOption) {
    const client = option?.prisma ?? this.prisma;
    return client.chatWidgetGroup.findMany({
      where: { orgUnitId, widget: { active: true } },
      select: { widgetId: true, isDefault: true },
    });
  }

  /**
   * Replaces the unit's active chats. Rows of inactive widgets are kept, so
   * switching a widget back on restores its groups; only one default remains.
   */
  async replaceGroup(
    orgUnitId: string,
    widgetIds: readonly string[],
    defaultId: string | null,
    option: TxOption,
  ): Promise<void> {
    const client = option.prisma ?? this.prisma;
    await client.chatWidgetGroup.deleteMany({
      where: { orgUnitId, widget: { active: true } },
    });
    if (defaultId) {
      await client.chatWidgetGroup.updateMany({
        where: { orgUnitId },
        data: { isDefault: false },
      });
    }
    if (widgetIds.length) {
      await client.chatWidgetGroup.createMany({
        data: widgetIds.map((widgetId) => ({
          widgetId,
          orgUnitId,
          isDefault: widgetId === defaultId,
        })),
      });
    }
  }
}
