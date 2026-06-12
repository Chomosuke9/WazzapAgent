// src/protocol/types.ts
//
// Node-side realization of CONTRACT.md §5 (TypeScript Types), with the inbound
// message payload from CONTRACT.md §7 and the ErrorCode set from CONTRACT.md §2.
//
// TYPES ONLY. This module emits NOTHING at runtime: no value exports, no
// validation, no encode/decode. Every declaration below is `export type` or
// `export interface`, so the compiled output is empty. Do not import this from
// any production module yet (later steps wire it in).
//
// Baileys/ws types are referenced via `import("baileys")` / `import("ws")`
// rather than re-defined, exactly as shown in CONTRACT.md §5.

// ---- shared ----
export type WaStatus = "open" | "connecting" | "close";
export type ErrorCode =
  | "not_found" | "not_group" | "permission_denied"
  | "invalid_target" | "send_failed" | "timeout";

export interface Attachment {
  kind: "image" | "video" | "audio" | "sticker" | "document";
  path: string;
  fileName?: string;
  caption?: string;
  mime?: string;
  thumbnailBase64?: string;
}

// ---- inbound frames Node RECEIVES from Python ----
export interface HelloPayload { folderPath: string; protocolVersion: "2.0"; }

export interface SendMessagePayload {
  requestId: string; chatId: string;
  text?: string; replyTo?: string | null; attachments?: Attachment[];
}
export interface ReactMessagePayload { requestId: string; chatId: string; contextMsgId: string; emoji: string; }
export interface DeleteMessagePayload { requestId: string; chatId: string; contextMsgId: string; }
export interface KickTarget { senderRef: string; anchorContextMsgId: string; }
export interface KickMemberPayload {
  requestId: string; chatId: string; targets: KickTarget[];
  mode: "partial_success" | "all_or_nothing"; autoReplyAnchor: boolean;
}
export interface MarkReadPayload { chatId: string; messageId: string; participant?: string; }
export interface SendPresencePayload { chatId: string; type: "composing" | "paused"; }
export interface QuizChoice { label: string; text: string; }
export interface SendQuizPayload {
  requestId: string; chatId: string; question: string; choices: QuizChoice[];
  replyTo?: string | null; footer?: string | null;
}
export interface SendCopyCodePayload {
  requestId: string; chatId: string; code: string; displayText: string;
  replyTo?: string | null; quotedPreviewText?: string;
}
export interface RelayLottieStickerPayload {
  requestId: string; chatId: string; lottiePayload: string; replyTo?: string | null;
}
export interface NativeButton { name: string; buttonParams?: Record<string, unknown>; buttonParamsJson?: string; }
export interface SendButtonsPayload {
  requestId: string; chatId: string; text: string; buttons: NativeButton[]; footer?: string;
}
export interface CarouselCard {
  image?: string; video?: string; body?: string; footer?: string; buttons: NativeButton[];
}
export interface SendCarouselPayload { requestId: string; chatId: string; cards: CarouselCard[]; text?: string; }
export interface RunCommandPayload { requestId: string; chatId: string; command: string; contextMsgId?: string; }

export type InboundActionFrame =
  | { type: "send_message"; payload: SendMessagePayload }
  | { type: "react_message"; payload: ReactMessagePayload }
  | { type: "delete_message"; payload: DeleteMessagePayload }
  | { type: "kick_member"; payload: KickMemberPayload }
  | { type: "mark_read"; payload: MarkReadPayload }
  | { type: "send_presence"; payload: SendPresencePayload }
  | { type: "send_quiz"; payload: SendQuizPayload }
  | { type: "send_copy_code"; payload: SendCopyCodePayload }
  | { type: "relay_lottie_sticker"; payload: RelayLottieStickerPayload }
  | { type: "send_buttons"; payload: SendButtonsPayload }
  | { type: "send_carousel"; payload: SendCarouselPayload }
  | { type: "run_command"; payload: RunCommandPayload };

export type InboundFrame = { type: "hello"; payload: HelloPayload } | InboundActionFrame;

// ---- outbound frames Node SENDS to Python ----
export interface HelloAckPayload { folderPath: string; waStatus: WaStatus; }
export interface SentEntry { kind: string; contextMsgId: string; messageId: string | null; }
export type ActionResult =
  | { sent: SentEntry[]; replyTo: string | null }     // send_message
  | { contextMsgId: string; messageId?: string | null }
  | { succeeded: number; failed: number; results: Array<{ target: unknown; ok: boolean; detail?: string; error?: string }> }
  | { command: string | null; error?: string }
  | Record<string, unknown>;                            // raw Baileys msg objects
export interface ActionAckPayload {
  requestId: string; action: string; ok: boolean; detail: string;
  code?: ErrorCode | null; result?: ActionResult;
}
export interface SendAckPayload { requestId: string; }
export interface WsErrorPayload {
  message: string; detail: string; code: ErrorCode; requestId?: string; action?: string;
}
export interface WhatsAppStatusPayload {
  folderPath: string; status: WaStatus; reason?: number; instanceId: string;
}

// IncomingMessagePayload — CONTRACT.md §7 (WhatsAppMessagePayload), mirrored below.
// `Always` fields are required; `Optional` fields are marked with `?`.
export interface WhatsAppMessagePayload {
  folderPath: string;                                   // Always
  instanceId: string;                                   // Always
  chatId: string;                                       // Always
  chatName: string;                                     // Always
  chatType: "group" | "private";                        // Always
  messageId: string;                                    // Always
  contextMsgId?: string;                                // Optional
  senderId: string;                                     // Always
  senderRef: string;                                    // Always
  senderName: string;                                   // Always
  senderIsAdmin: boolean;                               // Always
  senderIsSuperAdmin: boolean;                          // Always
  senderIsOwner?: boolean;                              // Optional
  isGroup: boolean;                                     // Always
  botIsAdmin: boolean;                                  // Always
  botIsSuperAdmin: boolean;                             // Always
  fromMe: boolean;                                      // Always
  contextOnly: boolean;                                 // Always
  triggerLlm1: boolean;                                 // Always
  timestampMs: number;                                  // Always
  messageType: string;                                  // Always
  text?: string | null;                                 // Optional
  quoted?: {
    messageId: string;
    contextMsgId: string;
    senderId: string;
    senderRef?: string;
    text: string;
    type: string;
    fromMe?: boolean;
    senderIsAdmin?: boolean;
    senderIsSuperAdmin?: boolean;
    mentionedParticipants?: { jid: string; senderRef: string; name: string; isBot: boolean }[];
  } | null;                                             // Optional
  attachments: Attachment[];                            // Always (may be [])
  mentionedJids?: string[] | null;                      // Optional
  mentionedParticipants?: { jid: string; senderRef: string; name: string; isBot: boolean }[] | null; // Optional
  botMentioned?: boolean;                               // Optional
  repliedToBot?: boolean;                               // Optional
  location?: { degreesLatitude: number; degreesLongitude: number } | null; // Optional
  groupDescription?: string | null;                    // Optional
  slashCommand?: { command: string; args: string } | null; // Optional
  commandHandled?: boolean;                             // Optional
  groupEvent?: {
    action: string;
    participants?: string[];
    actorId?: string;
    actorName?: string;
    source: string;
  } | null;                                             // Optional
  actionLog?: { action: string; result: unknown } | null; // Optional
}

export type OutboundFrame =
  | { type: "hello_ack"; payload: HelloAckPayload }
  | { type: "action_ack"; payload: ActionAckPayload }
  | { type: "send_ack"; payload: SendAckPayload }
  | { type: "error"; payload: WsErrorPayload }
  | { type: "incoming_message"; payload: WhatsAppMessagePayload }
  | { type: "whatsapp_status"; payload: WhatsAppStatusPayload }
  // control events (top-level fields, no payload wrapper):
  | { type: "clear_history"; folderPath: string; chatId: string }
  | { type: "set_llm2_model"; folderPath: string; chatId: string; modelId: string | null }
  | { type: "invalidate_llm2_model"; folderPath: string; chatId: string }
  | { type: "invalidate_default_model"; folderPath: string }
  | { type: "invalidate_chat_settings"; folderPath: string; chatId: string }
  | { type: "set_subagent_enabled"; folderPath: string; chatId: string; enabled: boolean };

// ---- registry & factory ----

// The per-account state holder. Its concrete fields are an internal Node detail
// (per-account caches/identifiers/sendQueue) and intentionally NOT part of the
// wire contract. The canonical definition lives in `account/accountContext.ts`
// (Step 16); it is re-exported here so existing `import { AccountContext } from
// '../protocol/types.js'` sites keep resolving. This is a type-only re-export,
// so this module still emits NOTHING at runtime.
import type { AccountContext } from "../account/accountContext.js";
export type { AccountContext };
// Step 05: each AccountEntry OWNS its persistence — one Database + the four
// domain repositories built from it — pointed at THIS tenant's `<folderPath>/db`
// dir. Type-only imports, so this module still emits NOTHING at runtime.
import type { Database } from "../db/Database.js";
import type { AccountRepositories } from "../db/repositories/index.js";
export type { Database, AccountRepositories };

export interface AccountEntry {
  folderPath: string;                 // account key
  ctx: AccountContext;                // per-account caches/identifiers/sendQueue (Step 16)
  sock?: import("baileys").WASocket;  // live Baileys socket, undefined until created
  client?: import("ws").WebSocket;    // bound Python client, undefined when disconnected
  waStatus: WaStatus;
  reliableQueue: OutboundFrame[];     // per-account reliable queue (bound MAX_RELIABLE_QUEUE)
  database?: Database;                // per-tenant DB connection-owner (Step 05), opened by the factory
  repos?: AccountRepositories;        // per-tenant repositories built from `database` (Step 05)
}

export interface BaileysFactoryOptions {
  folderPath: string;                 // tenant folder; auth dir = `${folderPath}/auth`
  onStatusChange?: (status: WaStatus, reason?: number) => void;
  printQr?: boolean;                  // default true
}
