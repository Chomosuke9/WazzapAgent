import test from 'node:test';
import assert from 'node:assert/strict';

// Type-level compile check for the WS protocol types (CONTRACT.md §5/§7).
// This file constructs one literal of each *Payload type, assigns each into the
// InboundFrame / OutboundFrame discriminated unions, and imports the union types
// to prove they resolve from another .ts module. There is no runtime behaviour
// to verify here — the value of the test is that it COMPILES. tsx transpiles it
// and the trivial assertion below confirms discovery + execution.

import type {
  // shared
  Attachment,
  // inbound payloads
  HelloPayload,
  SendMessagePayload,
  ReactMessagePayload,
  DeleteMessagePayload,
  KickMemberPayload,
  MarkReadPayload,
  SendPresencePayload,
  SendQuizPayload,
  SendCopyCodePayload,
  RelayLottieStickerPayload,
  SendButtonsPayload,
  SendCarouselPayload,
  RunCommandPayload,
  // outbound payloads
  HelloAckPayload,
  ActionAckPayload,
  SendAckPayload,
  WsErrorPayload,
  WhatsAppStatusPayload,
  WhatsAppMessagePayload,
  // unions (proving resolution)
  InboundFrame,
  OutboundFrame,
} from '../../src/protocol/types.ts';

// ---- one literal of each inbound *Payload ----
const helloPayload: HelloPayload = { folderPath: '/tenants/acme', protocolVersion: '2.0' };
const sendMessagePayload: SendMessagePayload = {
  requestId: 'send-1715097600000-000001',
  chatId: '12345@g.us',
  text: 'hello',
  replyTo: '000124',
  attachments: [{ kind: 'image', path: 'media/x.jpg', caption: 'cap' }],
};
const reactMessagePayload: ReactMessagePayload = {
  requestId: 'react-1715097600000-000002', chatId: '12345@g.us', contextMsgId: '000125', emoji: '👍',
};
const deleteMessagePayload: DeleteMessagePayload = {
  requestId: 'delete-1715097600000-000003', chatId: '12345@g.us', contextMsgId: '000125',
};
const kickMemberPayload: KickMemberPayload = {
  requestId: 'kick-1715097600000-000004',
  chatId: '12345@g.us',
  targets: [{ senderRef: 'u8k2d1', anchorContextMsgId: '000125' }],
  mode: 'partial_success',
  autoReplyAnchor: true,
};
const markReadPayload: MarkReadPayload = {
  chatId: '12345@g.us', messageId: 'wamid-abc', participant: '98765@s.whatsapp.net',
};
const sendPresencePayload: SendPresencePayload = { chatId: '12345@g.us', type: 'composing' };
const sendQuizPayload: SendQuizPayload = {
  requestId: 'quiz-1715097600000-000005',
  chatId: '12345@g.us',
  question: 'Capital of Indonesia?',
  choices: [{ label: 'A', text: 'Jakarta' }, { label: 'B', text: 'Bali' }],
  replyTo: null,
  footer: null,
};
const sendCopyCodePayload: SendCopyCodePayload = {
  requestId: 'copy-1715097600000-000006',
  chatId: '12345@g.us',
  code: 'PROMO2024',
  displayText: 'Copy Code',
  quotedPreviewText: 'Your promo code: PROMO2024',
};
const relayLottieStickerPayload: RelayLottieStickerPayload = {
  requestId: 'sticker-1715097600000-000007', chatId: '12345@g.us', lottiePayload: '{}', replyTo: null,
};
const sendButtonsPayload: SendButtonsPayload = {
  requestId: 'send-1715097600000-000008',
  chatId: '12345@g.us',
  text: 'Choose:',
  buttons: [{ name: 'quick_reply', buttonParams: { display_text: 'A', id: 'a' } }],
  footer: 'footer',
};
const sendCarouselPayload: SendCarouselPayload = {
  requestId: 'send-1715097600000-000009',
  chatId: '12345@g.us',
  cards: [{ body: 'card', buttons: [{ name: 'cta_url', buttonParamsJson: '{}' }] }],
  text: 'header',
};
const runCommandPayload: RunCommandPayload = {
  requestId: 'cmd-1715097600000-000010', chatId: '12345@g.us', command: '/sticker', contextMsgId: '000125',
};

// ---- one literal of each outbound *Payload ----
const helloAckPayload: HelloAckPayload = { folderPath: '/tenants/acme', waStatus: 'open' };
const actionAckPayload: ActionAckPayload = {
  requestId: 'send-1715097600000-000001',
  action: 'send_message',
  ok: true,
  detail: 'sent',
  code: null,
  result: { sent: [{ kind: 'text', contextMsgId: '000125', messageId: 'wamid-abc' }], replyTo: null },
};
const sendAckPayload: SendAckPayload = { requestId: 'send-1715097600000-000001' };
const wsErrorPayload: WsErrorPayload = {
  message: 'delete_message failed', detail: 'not found', code: 'not_found',
  requestId: 'delete-1715097600000-000003', action: 'delete_message',
};
const whatsAppStatusPayload: WhatsAppStatusPayload = {
  folderPath: '/tenants/acme', status: 'close', reason: 401, instanceId: 'gateway-1',
};
const sampleAttachment: Attachment = { kind: 'document', path: 'media/doc.pdf' };
const whatsAppMessagePayload: WhatsAppMessagePayload = {
  folderPath: '/tenants/acme',
  instanceId: 'gateway-1',
  chatId: '12345@g.us',
  chatName: 'Group',
  chatType: 'group',
  messageId: 'wamid-abc',
  senderId: '98765@s.whatsapp.net',
  senderRef: 'u8k2d1',
  senderName: 'Alice',
  senderIsAdmin: false,
  senderIsSuperAdmin: false,
  isGroup: true,
  botIsAdmin: true,
  botIsSuperAdmin: false,
  fromMe: false,
  contextOnly: false,
  triggerLlm1: false,
  timestampMs: 1715097600000,
  messageType: 'extendedTextMessage',
  text: 'Hello world',
  attachments: [sampleAttachment],
};

// ---- assign each into the union types (proves discriminated-union membership) ----
const inboundFrames: InboundFrame[] = [
  { type: 'hello', payload: helloPayload },
  { type: 'send_message', payload: sendMessagePayload },
  { type: 'react_message', payload: reactMessagePayload },
  { type: 'delete_message', payload: deleteMessagePayload },
  { type: 'kick_member', payload: kickMemberPayload },
  { type: 'mark_read', payload: markReadPayload },
  { type: 'send_presence', payload: sendPresencePayload },
  { type: 'send_quiz', payload: sendQuizPayload },
  { type: 'send_copy_code', payload: sendCopyCodePayload },
  { type: 'relay_lottie_sticker', payload: relayLottieStickerPayload },
  { type: 'send_buttons', payload: sendButtonsPayload },
  { type: 'send_carousel', payload: sendCarouselPayload },
  { type: 'run_command', payload: runCommandPayload },
];

const outboundFrames: OutboundFrame[] = [
  { type: 'hello_ack', payload: helloAckPayload },
  { type: 'action_ack', payload: actionAckPayload },
  { type: 'send_ack', payload: sendAckPayload },
  { type: 'error', payload: wsErrorPayload },
  { type: 'incoming_message', payload: whatsAppMessagePayload },
  { type: 'whatsapp_status', payload: whatsAppStatusPayload },
  { type: 'clear_history', folderPath: '/tenants/acme', chatId: 'global' },
  { type: 'set_llm2_model', folderPath: '/tenants/acme', chatId: '12345@g.us', modelId: 'gpt-4o' },
  { type: 'invalidate_llm2_model', folderPath: '/tenants/acme', chatId: 'global' },
  { type: 'invalidate_default_model', folderPath: '/tenants/acme' },
  { type: 'invalidate_chat_settings', folderPath: '/tenants/acme', chatId: '12345@g.us' },
  { type: 'set_subagent_enabled', folderPath: '/tenants/acme', chatId: '12345@g.us', enabled: true },
];

test('protocol types: payload literals assign into InboundFrame/OutboundFrame unions', () => {
  // The compile step is the real assertion. At runtime, just confirm the
  // arrays were constructed so the test is observably executed.
  assert.equal(inboundFrames.length, 13);
  assert.equal(outboundFrames.length, 12);
  assert.equal(true, true);
});
