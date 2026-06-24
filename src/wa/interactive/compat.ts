/**
 * compat.ts — Per-chat device "compatibility mode": which interactive message
 * kinds the bot may send to a chat, derived from either an explicit per-chat
 * setting or (in `auto`) the detected device of the chat's audience.
 *
 * Tiers map to device capability observed in the field:
 *   - full  (Android): every interactive kind renders.
 *   - semi  (iOS):     everything EXCEPT single_select / list menus.
 *   - safe  (web / desktop / unknown): no interactive — plain text only.
 *
 * The gate is enforced entirely Node-side at the send choke points
 * (`outbound.ts` rich replies + `actionDispatcher.ts`
 * send_quiz/send_buttons/send_carousel/send_copy_code), so there is NO protocol
 * or Python change. When a kind is disallowed the caller renders one of the
 * plain-text fallbacks below instead of dropping the message.
 *
 * Device detection itself is Baileys' `getDevice(messageId)` (a heuristic on
 * the WhatsApp message-id shape); see `inbound.ts`, which persists the last
 * KNOWN device per chat into `auto_device` for the `auto` resolution here.
 */
import { getDevice } from 'baileys';
import type { AccountRepositories } from '../../db/repositories/index.js';

/** Device classes as predicted by Baileys' `getDevice(messageId)`. */
export type Device = 'android' | 'ios' | 'web' | 'desktop' | 'unknown';

/** Capability tier — also the explicit (non-`auto`) values of the setting. */
export type Tier = 'full' | 'semi' | 'safe';

/** Per-chat `compatibility_mode` value. `auto` derives the tier from device. */
export type CompatMode = 'auto' | Tier;

/** Interactive message kinds the gate distinguishes. */
export type InteractiveKind =
  | 'list' // single_select / listMessage — the one kind broken on iOS too
  | 'quick_reply' // quiz + generic quick replies
  | 'cta_url'
  | 'cta_copy'
  | 'cta_call'
  | 'native_flow'
  | 'carousel'
  | 'rich'; // sendRichMessage styled reply

/**
 * Map a detected device to its capability tier. `web`, `desktop`, `unknown`
 * and any unrecognized value all fall through to `safe` (answers 2 + 3).
 */
export function deviceToTier(device: Device | string | null | undefined): Tier {
  switch (device) {
    case 'android':
      return 'full';
    case 'ios':
      return 'semi';
    default:
      return 'safe';
  }
}

/** Whether a tier permits a given interactive kind. */
export function tierAllows(tier: Tier, kind: InteractiveKind): boolean {
  if (tier === 'safe') return false;
  if (tier === 'semi') return kind !== 'list';
  return true; // full
}

/**
 * Resolve the effective tier for a chat. An explicit `full`/`semi`/`safe`
 * setting wins; `auto` derives from the last KNOWN device of the chat's
 * audience (the DM peer, or a group admin/owner — see `inbound.ts`), defaulting
 * to `safe` when no device is known yet.
 *
 * `repos` is optional: when absent (abnormal — repos are wired before any
 * message flows) the tier is `full`, preserving pre-feature behavior so nothing
 * is unexpectedly downgraded (e.g. in unit tests that don't build a DB).
 */
export function resolveTier(repos: AccountRepositories | undefined, chatId: string): Tier {
  if (!repos) return 'full';
  const mode = repos.settings.getCompatibilityMode(chatId);
  if (mode === 'full' || mode === 'semi' || mode === 'safe') return mode;
  // auto → derive from the last known device, else safe.
  return deviceToTier(repos.settings.getAutoDevice(chatId));
}

/**
 * Resolve the effective tier for an interactive message sent in DIRECT RESPONSE
 * to a caller — a slash command or a button tap (both carry the triggering
 * message). An explicit `full`/`semi`/`safe` `compatibility_mode` ALWAYS wins;
 * only `auto` falls back to the CALLER's OWN device (the device that just sent
 * the command / tapped the button), so the person reading the reply can operate
 * it via the matching slash commands.
 *
 * Contrast with {@link resolveTier}, which for `auto` derives from the chat
 * AUDIENCE's last-known device — the right choice for messages the bot sends
 * proactively (LLM replies, quizzes) rather than in reply to a specific caller.
 *
 * When `repos` is absent (abnormal) the explicit setting can't be read, so the
 * tier comes purely from the caller's device.
 */
export function resolveCallerTier(
  repos: AccountRepositories | undefined,
  chatId: string,
  callerMessageId: string | null | undefined,
): Tier {
  const callerTier = deviceToTier(getDevice(callerMessageId || ''));
  // Explicit setting wins when readable; otherwise (no repos / no settings repo
  // / `auto`) the tier is the caller's own device.
  const mode = repos?.settings?.getCompatibilityMode?.(chatId);
  if (mode === 'full' || mode === 'semi' || mode === 'safe') return mode;
  return callerTier;
}

// ---------------------------------------------------------------------------
// Plain-text fallbacks (pure — no socket). Used when a tier disallows a kind.
// The text is sent through `sendOutgoing`, which resolves `@Name (senderRef)`
// mentions, so callers pass the raw LLM text (mention tokens intact).
// ---------------------------------------------------------------------------

/** Quiz / quick-reply → question followed by a numbered choice list. */
export function quizFallbackText(
  question: string,
  choices: Array<{ label?: string; text: string }>,
): string {
  const lines = (choices || []).map((c, i) => `${i + 1}. ${c.text}`);
  const body = (question || '').trim();
  const list = lines.join('\n');
  return [body, list].filter(Boolean).join('\n\n') + '\n\n_Reply with your choice._';
}

/** Parse a NativeFlow button's params JSON, tolerating malformed input. */
function parseButtonParams(buttonParamsJson?: string): Record<string, unknown> {
  if (!buttonParamsJson) return {};
  try {
    const parsed = JSON.parse(buttonParamsJson);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Render a single button as a text bullet, surfacing url/copy/call payloads. */
function buttonLine(button: { name?: string; buttonParamsJson?: string }): string | null {
  const params = parseButtonParams(button.buttonParamsJson);
  const label = String(params.display_text || params.title || '').trim();
  const url = typeof params.url === 'string' ? params.url : '';
  const copy = typeof params.copy_code === 'string' ? params.copy_code : '';
  const phone = typeof params.phone_number === 'string' ? params.phone_number : '';
  if (url) return `• ${label || url}: ${url}`;
  if (copy) return `• ${label ? label + ': ' : ''}${copy}`;
  if (phone) return `• ${label || 'Call'}: ${phone}`;
  return label ? `• ${label}` : null;
}

/** Generic NativeFlow buttons → body followed by a bullet list of options. */
export function buttonsFallbackText(
  text: string,
  buttons: Array<{ name?: string; buttonParamsJson?: string }>,
): string {
  const lines = (buttons || []).map(buttonLine).filter((l): l is string => Boolean(l));
  const body = (text || '').trim();
  return lines.length ? [body, lines.join('\n')].filter(Boolean).join('\n\n') : body;
}

/** Single CTA copy-code → a monospace block (long-press to copy on mobile). */
export function copyCodeFallbackText(
  code: string,
  displayText?: string,
  quotedPreviewText?: string,
): string {
  const head = quotedPreviewText ? `${quotedPreviewText.trim()}\n\n` : '';
  const label = displayText && displayText !== 'Copy Code' ? `${displayText}:\n` : '';
  return `${head}${label}\`\`\`\n${code}\n\`\`\``;
}

/** Swipeable carousel → one titled text block per card. */
export function carouselFallbackText(
  text: string | undefined,
  cards: Array<{
    body?: string;
    footer?: string;
    buttons?: Array<{ name?: string; buttonParamsJson?: string }>;
  }>,
): string {
  const blocks = (cards || []).map((card, i) => {
    const parts: string[] = [`*${i + 1}.*${card.body ? ' ' + card.body.trim() : ''}`];
    if (card.footer) parts.push(card.footer.trim());
    const btns = buttonsFallbackText('', card.buttons || []).trim();
    if (btns) parts.push(btns);
    return parts.join('\n');
  });
  return [(text || '').trim(), ...blocks].filter(Boolean).join('\n\n');
}
