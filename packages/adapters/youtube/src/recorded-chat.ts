/**
 * Parser for recorded YouTube chat (`yt-dlp --write-subs --sub-langs live_chat`
 * produces `<id>.live_chat.json`, one JSON object per line). Used by
 * scripts/replay.ts to tune the scorer on past VODs.
 *
 * Returns events with `ts` = offset in ms from the start of the VOD.
 */
import type { ChatEvent, ChatEventKind } from '@inbetween/shared';

function runsToText(runs: any[] | undefined): string {
  if (!runs) return '';
  return runs
    .map((r) => {
      if (r.text != null) return r.text;
      if (r.emoji) {
        const e = r.emoji;
        // Standard emoji carry the character as emojiId; custom/member emoji use :shortcut:
        if (!e.isCustomEmoji && e.emojiId && !/^UC/.test(e.emojiId)) return e.emojiId;
        return e.shortcuts?.[0] ?? e.searchTerms?.[0] ?? '';
      }
      return '';
    })
    .join('');
}

function parseAmount(s: string | undefined): { amount: number; currency: string | null } {
  if (!s) return { amount: 0, currency: null };
  const num = Number(s.replace(/[^0-9.]/g, ''));
  const cur = s.replace(/[0-9.,\s]/g, '') || null;
  return { amount: Number.isFinite(num) ? num : 0, currency: cur };
}

const RENDERERS: Record<string, { kind: ChatEventKind; paid: boolean }> = {
  liveChatTextMessageRenderer: { kind: 'text', paid: false },
  liveChatPaidMessageRenderer: { kind: 'paid_message', paid: true },
  liveChatPaidStickerRenderer: { kind: 'paid_sticker', paid: true },
  liveChatMembershipItemRenderer: { kind: 'membership', paid: true },
  liveChatSponsorshipsGiftPurchaseAnnouncementRenderer: { kind: 'membership_gift', paid: true },
};

export function parseYtDlpLiveChat(content: string): ChatEvent[] {
  const out: ChatEvent[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const replay = obj.replayChatItemAction;
    const offsetMs = Number(replay?.videoOffsetTimeMsec ?? NaN);
    const actions = replay?.actions ?? (obj.addChatItemAction ? [obj] : []);
    for (const action of actions) {
      const item = action?.addChatItemAction?.item;
      if (!item) continue;
      const [rendererName, r] = Object.entries(item)[0] as [string, any];
      const spec = RENDERERS[rendererName];
      if (!spec || !r) continue;
      let text = runsToText(r.message?.runs);
      if (rendererName === 'liveChatPaidStickerRenderer') text = r.sticker?.accessibility?.accessibilityData?.label ?? '';
      if (rendererName === 'liveChatMembershipItemRenderer') text = runsToText(r.headerSubtext?.runs) || runsToText(r.message?.runs);
      if (rendererName === 'liveChatSponsorshipsGiftPurchaseAnnouncementRenderer') {
        r.authorExternalChannelId ??= r.header?.liveChatSponsorshipsHeaderRenderer?.authorExternalChannelId;
      }
      const { amount, currency } = parseAmount(r.purchaseAmountText?.simpleText);
      const ts = Number.isFinite(offsetMs) ? offsetMs : Number(r.timestampUsec ?? 0) / 1000;
      out.push({
        id: String(r.id ?? `${ts}-${out.length}`),
        platform: 'youtube',
        ts,
        authorId: String(r.authorExternalChannelId ?? ''),
        authorName: String(r.authorName?.simpleText ?? ''),
        text,
        kind: spec.kind,
        isPaid: spec.paid,
        amount,
        currency,
        amountDisplay: r.purchaseAmountText?.simpleText ?? null,
        isMember: (r.authorBadges ?? []).some((b: any) => b?.liveChatAuthorBadgeRenderer?.customThumbnail),
      });
    }
  }
  return out.sort((a, b) => a.ts - b.ts);
}
