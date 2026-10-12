import { createHmac, timingSafeEqual } from 'crypto';

/**
 * CD-66 — the LINE Messaging API connector's pure parts: the webhook
 * signature and turning a text message into a submission. Kept apart from the
 * controller so each is tested without a network.
 */

/** LINE signs the raw body with the channel secret (HMAC-SHA256, base64). */
export function lineSignatureValid(
  rawBody: Buffer,
  signature: string | undefined,
  channelSecret: string,
): boolean {
  if (!signature || !channelSecret) return false;
  const expected = createHmac('sha256', channelSecret).update(rawBody).digest();
  let given: Buffer;
  try {
    given = Buffer.from(signature, 'base64');
  } catch {
    return false;
  }
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export interface LineEvent {
  type: string;
  replyToken?: string;
  timestamp?: number;
  source?: { type?: string; userId?: string };
  message?: {
    id?: string;
    type?: string;
    text?: string;
    fileName?: string;
    title?: string;
    address?: string;
    latitude?: number;
    longitude?: number;
  };
}

/** CD-285 — what a LINE message becomes in an AI CARE conversation. */
export interface CareLineMessage {
  userId: string;
  replyToken: string | null;
  at: Date | undefined;
  text: string | null;
  attachment: {
    name: string;
    type: string;
    url?: string;
    /** content to copy from LINE (image, video, audio, file) */
    source?: 'line';
    lineMessageId?: string;
  } | null;
}

const MEDIA = ['image', 'video', 'audio', 'file'];
const MEDIA_TH: Record<string, string> = {
  image: 'รูปภาพ',
  video: 'วิดีโอ',
  audio: 'ข้อความเสียง',
  file: 'ไฟล์',
};

/**
 * CD-285 — every message a person sends to the LINE OA, for AI CARE: text
 * as it is; an image, video, voice message or file as an attachment whose
 * content is copied from LINE later; a sticker or location recorded as what
 * it is (AI CARE answers text only). Groups and rooms are not customers.
 */
export function careMessages(events: readonly LineEvent[]): CareLineMessage[] {
  const out: CareLineMessage[] = [];
  for (const event of events) {
    if (event.type !== 'message' || event.source?.type !== 'user') continue;
    const userId = event.source.userId;
    const message = event.message;
    if (!userId || !message?.type) continue;
    const base = {
      userId,
      replyToken: event.replyToken ?? null,
      at: event.timestamp ? new Date(event.timestamp) : undefined,
    };
    if (message.type === 'text') {
      const text = message.text?.trim().slice(0, 4000);
      if (text) out.push({ ...base, text, attachment: null });
    } else if (MEDIA.includes(message.type) && message.id) {
      out.push({
        ...base,
        text: null,
        attachment: {
          name:
            message.fileName?.slice(0, 200) ||
            `${MEDIA_TH[message.type]} ${message.id}`,
          type: message.type,
          source: 'line',
          lineMessageId: message.id,
        },
      });
    } else if (message.type === 'sticker') {
      out.push({
        ...base,
        text: null,
        attachment: { name: 'สติกเกอร์', type: 'sticker' },
      });
    } else if (message.type === 'location') {
      const where =
        [message.title, message.address].filter(Boolean).join(' · ') ||
        'ตำแหน่ง';
      out.push({
        ...base,
        text: null,
        attachment: {
          name: where.slice(0, 200),
          type: 'location',
          ...(message.latitude !== undefined && message.longitude !== undefined
            ? {
                url: `https://www.google.com/maps?q=${message.latitude},${message.longitude}`,
              }
            : {}),
        },
      });
    }
  }
  return out;
}

/** Text messages from a person — the only events that raise a request. */
export function textMessages(
  events: readonly LineEvent[],
): { userId: string; text: string; replyToken: string | null }[] {
  return events
    .filter(
      (event) =>
        event.type === 'message' &&
        event.message?.type === 'text' &&
        event.source?.type === 'user' &&
        Boolean(event.source.userId) &&
        Boolean(event.message.text?.trim()),
    )
    .map((event) => ({
      userId: event.source!.userId!,
      text: event.message!.text!.trim().slice(0, 4000),
      replyToken: event.replyToken ?? null,
    }));
}

/**
 * Where the message goes in the request: the type's first free-text field
 * (multiline first). A type with no such field cannot take a chat message.
 */
export function messageField(
  fields: readonly { key: string; type: string }[],
): string | null {
  return (
    fields.find((field) => field.type === 'multiline')?.key ??
    fields.find((field) => field.type === 'text')?.key ??
    null
  );
}
