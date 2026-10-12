import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditWriter } from '@request-management/share';
import { KbAiService } from '../kb/kb-ai.service';
import { NotificationsService } from '../notifications/notifications.service';
import { OnCallService } from '../support/on-call.service';
import {
  DEFAULT_REMIND_MINUTES,
  HANDOVER_REASON_TH,
  handoverNotice,
  remindDue,
  type HandoverReason,
} from './care-handover-rules';
import {
  CareConversationRepository,
  CareStaffRepository,
} from './care.repositories';
import type { ConversationRow } from './care.service';

const MANAGE = 'service.care.manage';

const CHANNEL_TH: Record<string, string> = {
  line: 'LINE',
  facebook: 'Facebook',
  instagram: 'Instagram',
  tiktok: 'TikTok',
  email: 'อีเมล',
  web: 'เว็บแชต',
  callcenter: 'D-Callcenter',
  api: 'API',
};

/**
 * CD-283 (CD-23 AI CARE) — a conversation handed to a person. AI CARE stops
 * answering (the conversation waits for a person); in working hours everyone
 * holding `service.care.manage` is told, out of hours whoever is on call
 * (CD-241's rota and calendar — the same the SLA uses), and the whole team
 * when nobody is. The customer is told once. While nobody has taken it, the
 * sweep tells them again every `care.handoverRemindMinutes`.
 */
@Injectable()
export class CareHandoverService {
  private readonly logger = new Logger(CareHandoverService.name);

  constructor(
    private readonly conversations: CareConversationRepository,
    private readonly staff: CareStaffRepository,
    private readonly onCall: OnCallService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditWriter,
    private readonly config: ConfigService,
    private readonly kb: KbAiService,
  ) {}

  /**
   * CD-288 — a person takes part (handed over, or taken from AI) for the
   * first time: kept for good (the AI-closed rate) and the AI's last answer
   * fed back to KBMS as handed off.
   */
  async reachedPerson(
    conversation: { id: string; companyId: string },
    at = new Date(),
  ) {
    const first = await this.conversations.updateMany({
      where: { id: conversation.id, humanAt: null },
      data: { humanAt: at },
    });
    if (!first.count) return;
    await this.kb
      .handedOff(conversation.companyId, conversation.id, at)
      .catch((error: unknown) =>
        this.logger.warn(`KB handed-off not recorded: ${String(error)}`),
      );
  }

  /** Hand it over; returns what the customer is told. */
  async handOver(
    conversation: ConversationRow,
    reason: HandoverReason,
    by: string | null = null,
  ): Promise<string> {
    const now = new Date();
    const when = await this.onCall
      .now(conversation.companyId, now)
      .catch(() => ({ outOfHours: false, onCall: null }));
    await this.conversations.update({
      where: { id: conversation.id },
      data: {
        status: 'waiting_human',
        handoverReason: reason,
        handoverAt: now,
        handoverNotifiedAt: now,
        caseOfferedAt: null,
      },
    });
    await this.reachedPerson(conversation, now);
    await this.tell(conversation, reason, when, null);
    await this.audit.record({
      eventType: 'care.handover',
      companyId: conversation.companyId,
      actorId: by,
      actorUsername: by ? null : 'care:ai',
      resourceType: 'care_conversation',
      resourceId: conversation.id,
      after: {
        reason,
        outOfHours: when.outOfHours,
        onCall: when.onCall?.userId ?? null,
      },
    });
    return handoverNotice({
      outOfHours: when.outOfHours,
      onCall: !!when.onCall,
    });
  }

  /** Conversations still waiting: tell the team (or whoever is on call) again. */
  async remind(now = new Date()) {
    const minutes =
      Number(this.config.get('care.handoverRemindMinutes')) ||
      DEFAULT_REMIND_MINUTES;
    const waiting = (await this.conversations.findMany({
      where: {
        status: 'waiting_human',
        handoverNotifiedAt: { lte: new Date(now.getTime() - minutes * 60_000) },
      },
      take: 200,
    })) as ConversationRow[];
    let reminded = 0;
    for (const conversation of waiting) {
      if (!remindDue(conversation.handoverNotifiedAt, now, minutes)) continue;
      const when = await this.onCall
        .now(conversation.companyId, now)
        .catch(() => ({ outOfHours: false, onCall: null }));
      const waited = Math.round(
        (now.getTime() - (conversation.handoverAt ?? now).getTime()) / 60_000,
      );
      await this.tell(
        conversation,
        (conversation.handoverReason ?? 'asked') as HandoverReason,
        when,
        waited,
      );
      await this.conversations.update({
        where: { id: conversation.id },
        data: { handoverNotifiedAt: now },
      });
      reminded += 1;
    }
    return reminded;
  }

  private async tell(
    conversation: ConversationRow,
    reason: HandoverReason,
    when: { outOfHours: boolean; onCall: { userId: string } | null },
    waitedMinutes: number | null,
  ) {
    const people =
      when.outOfHours && when.onCall
        ? [when.onCall.userId]
        : await this.staff.holdersOf(conversation.companyId, MANAGE);
    for (const userId of people) {
      try {
        await this.notifications.careHandover(
          userId,
          conversation.companyId,
          {
            id: conversation.id,
            sender: conversation.senderName ?? conversation.senderRef,
            channel: CHANNEL_TH[conversation.channel] ?? conversation.channel,
          },
          HANDOVER_REASON_TH[reason] ?? reason,
          waitedMinutes,
        );
      } catch (error) {
        this.logger.warn(`care handover notice failed: ${String(error)}`);
      }
    }
  }
}
