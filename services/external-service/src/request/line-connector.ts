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
  source?: { type?: string; userId?: string };
  message?: { type?: string; text?: string };
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
