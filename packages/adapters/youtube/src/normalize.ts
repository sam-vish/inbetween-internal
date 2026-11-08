/**
 * Maps YouTube liveChatMessage resources to normalized ChatEvents.
 * Works for both transports: gRPC streamList (proto-loader camelCase,
 * enum names like TEXT_MESSAGE_EVENT) and REST list (camelCase JSON,
 * enum values like textMessageEvent).
 */
import type { ChatEvent, ChatEventKind } from '@inbetween/shared';

const typeKey = (t: unknown) => String(t ?? '').toLowerCase().replace(/_/g, '');

const KIND_BY_TYPE: Record<string, { kind: ChatEventKind; paid: boolean }> = {
  textmessageevent: { kind: 'text', paid: false },
  superchatevent: { kind: 'paid_message', paid: true },
  superstickerevent: { kind: 'paid_sticker', paid: true },
  fanfundingevent: { kind: 'paid_message', paid: true },
  newsponsorevent: { kind: 'membership', paid: true },
  membermilestonechatevent: { kind: 'membership', paid: true },
  membershipgiftingevent: { kind: 'membership_gift', paid: true },
  giftmembershipreceivedevent: { kind: 'system', paid: false },
  giftevent: { kind: 'gift', paid: true },
};

function micros(v: unknown): number {
  if (v == null) return 0;
  const n = typeof v === 'string' ? Number(v) : Number(v);
  return Number.isFinite(n) ? n / 1e6 : 0;
}

export function normalizeYouTubeMessage(item: any): ChatEvent | null {
  const s = item?.snippet;
  if (!s) return null;
  const tk = typeKey(s.type);
  const map = KIND_BY_TYPE[tk];
  if (!map) return null; // tombstones, bans, poll events, chat ended, sponsor-only mode, …

  const a = item.authorDetails ?? {};
  const sc = s.superChatDetails;
  const ss = s.superStickerDetails;
  const ff = s.fanFundingEventDetails;
  const mm = s.memberMilestoneChatDetails;
  const mg = s.membershipGiftingDetails;
  const gift = s.giftDetails;

  const text: string =
    s.textMessageDetails?.messageText ??
    sc?.userComment ??
    ff?.userComment ??
    mm?.userComment ??
    (ss ? (ss.superStickerMetadata?.altText ?? '') : undefined) ??
    s.displayMessage ??
    '';

  let amount = 0;
  let currency: string | null = null;
  let amountDisplay: string | null = null;
  if (sc) {
    amount = micros(sc.amountMicros);
    currency = sc.currency ?? null;
    amountDisplay = sc.amountDisplayString ?? null;
  } else if (ss) {
    amount = micros(ss.amountMicros);
    currency = ss.currency ?? null;
    amountDisplay = ss.amountDisplayString ?? null;
  } else if (ff) {
    amount = micros(ff.amountMicros);
    currency = ff.currency ?? null;
    amountDisplay = ff.amountDisplayString ?? null;
  } else if (mg) {
    amount = Number(mg.giftMembershipsCount ?? 0);
    currency = 'GIFTED_MEMBERSHIPS';
  } else if (gift) {
    amount = Number(gift.jewelsAmount ?? 0) * Math.max(1, Number(gift.comboCount ?? 1));
    currency = 'JEWELS';
  }

  const ts = Date.parse(s.publishedAt ?? '') || Date.now();
  return {
    id: String(item.id ?? `${ts}-${a.channelId ?? ''}`),
    platform: 'youtube',
    ts,
    authorId: String(a.channelId ?? s.authorChannelId ?? ''),
    authorName: String(a.displayName ?? ''),
    text: String(text),
    kind: map.kind,
    isPaid: map.paid,
    amount,
    currency,
    amountDisplay,
    isMember: !!a.isChatSponsor,
    isModerator: !!a.isChatModerator,
    isOwner: !!a.isChatOwner,
  };
}

export function isChatEndedMessage(item: any): boolean {
  return typeKey(item?.snippet?.type) === 'chatendedevent';
}
