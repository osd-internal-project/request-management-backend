import { createHash, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type {
  CallOutcome,
  DCallcenterClient,
  OutboundCall,
} from './dcallcenter-client';

/** The spread of outcomes the mock gives, chosen by the number's last digit. */
const BY_DIGIT: CallOutcome[] = [
  'interested',
  'not_interested',
  'no_answer',
  'interested',
  'busy',
  'not_interested',
  'no_answer',
  'refused',
  'interested',
  'not_interested',
];

/**
 * A call centre that answers at once and the same way for the same number —
 * so a test, a smoke run or a demo walks every path (interest, refusal, no
 * answer) without a real call. Transcripts say they are made up.
 */
@Injectable()
export class MockDCallcenterClient implements DCallcenterClient {
  readonly mode = 'mock' as const;

  placeCall(call: OutboundCall) {
    const callId = `mock-${randomUUID()}`;
    const digit = Number(call.to.slice(-1) || '0');
    const outcome = BY_DIGIT[Number.isFinite(digit) ? digit : 0];
    const answered = outcome !== 'no_answer' && outcome !== 'busy';
    const customer: Record<CallOutcome, string> = {
      interested: 'สนใจครับ ส่งรายละเอียดและให้ฝ่ายขายติดต่อกลับได้เลย',
      not_interested: 'ตอนนี้ยังไม่สนใจครับ ขอบคุณ',
      refused: 'ไม่ต้องติดต่ออีก',
      no_answer: '',
      busy: '',
      failed: '',
    };
    return Promise.resolve({
      callId,
      result: {
        callId,
        outcome,
        durationSec: answered
          ? 30 +
            (parseInt(
              createHash('sha1').update(call.to).digest('hex').slice(0, 2),
              16,
            ) %
              120)
          : 0,
        transcript: answered
          ? `[ข้อมูลจำลอง]\nAI: ${call.opening}\nAI: ${call.script}\nลูกค้า: ${customer[outcome]}`
          : null,
        recordingRef: answered ? `mock://recordings/${callId}.wav` : null,
      },
    });
  }
}
