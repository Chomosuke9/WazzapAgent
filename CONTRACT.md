# CONTRACT.md — Single Source of Truth

This document defines **every** interface, type, and wire shape that crosses the
Node ↔ Python boundary (or that both sides must agree on) in the post-migration
system. Every `steps/step-NN-*.md` references this file. **No step file may
redefine anything defined here.** If a step needs a shape not in this document,
the shape is added here first.

Protocol version: **`"2.0"`** (the version reported in the `hello` handshake).

> Relationship to `MIGRATION_PLAN.md`: this contract is authoritative where the
> two differ. In particular, **Section 8 (per-tenant DBs) supersedes the
> "DBs stay shared" note in MIGRATION_PLAN.md decision D2** — see the note in
> Section 8.

---

## Conventions

- Types use TypeScript notation in Sections 1/5 and Python annotations in
  Sections 4/6/7.
- `field?: T` means optional/omittable (may be absent or `null` unless stated).
- A WS **frame** is always `{ type: string, payload: object }` **except** the
  control events `clear_history` / `set_llm2_model` / `invalidate_*` /
  `set_subagent_enabled`, which place their data at the **top level** of the
  frame (kept verbatim from the legacy protocol — see Section 1.5).
- "reliable" = queued in memory and flushed on reconnect (never silently
  dropped while disconnected). "best-effort" = dropped if the socket is not
  OPEN at send time.

---

## 1. WS Protocol

### 1.1 Handshake

#### `hello` (Python → Node, reliable)
First frame a `WaSocket` sends on every (re)connect.
```ts
{
  type: "hello"
  payload: {
    folderPath: string          // absolute path to the tenant folder (account key)
    protocolVersion: "2.0"
  }
}
```

#### `hello_ack` (Node → Python, reliable)
Node's reply once the account's Baileys socket is created/resumed and the client
is bound in the registry.
```ts
{
  type: "hello_ack"
  payload: {
    folderPath: string          // echoes the hello folderPath
    waStatus: WaStatus          // "open" | "connecting" | "close"
  }
}
```

`WaStatus = "open" | "connecting" | "close"` is the **normalized** WhatsApp
connection lifecycle. Node maps Baileys `connection.update`:
`"open"→"open"`, `"connecting"/undefined→"connecting"`, `"close"/"closed"→"close"`.

### 1.2 Actions (Python → Node)

All actions are **best-effort** at the transport layer. Every action **except
`mark_read` and `send_presence`** carries a `requestId` (Section 3) and receives
exactly one `action_ack` (and, for `send_message`, an additional `send_ack`) or
one `error`. `mark_read` and `send_presence` carry **no** `requestId` and receive
**no** ack.

`Attachment` (shared shape used by `send_message`):
```ts
type Attachment = {
  kind: "image" | "video" | "audio" | "sticker" | "document"
  path: string                  // tenant-relative or absolute path readable by Node
  fileName?: string
  caption?: string
  mime?: string
  thumbnailBase64?: string       // base64 JPEG, document previews only
}
```

#### `send_message` (→ `action_ack` + `send_ack`)
At least one of `text` / `attachments` must be non-empty.
```ts
{ type: "send_message"
  payload: {
    requestId: string
    chatId: string
    text?: string
    replyTo?: string | null     // a contextMsgId (6 digits) or null
    attachments?: Attachment[]
  } }
```

#### `react_message` (→ `action_ack`)
```ts
{ type: "react_message"
  payload: { requestId: string, chatId: string, contextMsgId: string, emoji: string } }
```

#### `delete_message` (→ `action_ack`)
```ts
{ type: "delete_message"
  payload: { requestId: string, chatId: string, contextMsgId: string } }
```

#### `kick_member` (→ `action_ack`)
```ts
{ type: "kick_member"
  payload: {
    requestId: string
    chatId: string
    targets: { senderRef: string, anchorContextMsgId: string }[]
    mode: "partial_success" | "all_or_nothing"
    autoReplyAnchor: boolean
  } }
```

#### `mark_read` (no ack)
```ts
{ type: "mark_read"
  payload: { chatId: string, messageId: string, participant?: string } }
```

#### `send_presence` (no ack)
```ts
{ type: "send_presence"
  payload: { chatId: string, type: "composing" | "paused" } }
```

#### `send_quiz` (→ `action_ack`)
```ts
{ type: "send_quiz"
  payload: {
    requestId: string
    chatId: string
    question: string
    choices: { label: string, text: string }[]   // 2–5; text ≤ 20 chars
    replyTo?: string | null
    footer?: string | null
  } }
```

#### `send_copy_code` (→ `action_ack`)
```ts
{ type: "send_copy_code"
  payload: {
    requestId: string
    chatId: string
    code: string
    displayText: string          // default "Copy Code"
    replyTo?: string | null
    quotedPreviewText?: string
  } }
```

#### `relay_lottie_sticker` (→ `action_ack`)
```ts
{ type: "relay_lottie_sticker"
  payload: { requestId: string, chatId: string, lottiePayload: string, replyTo?: string | null } }
```

#### `send_buttons` (→ `action_ack`)
```ts
{ type: "send_buttons"
  payload: {
    requestId: string
    chatId: string
    text: string
    buttons: { name: string, buttonParams?: object, buttonParamsJson?: string }[]
    footer?: string
  } }
```

#### `send_carousel` (→ `action_ack`)
```ts
{ type: "send_carousel"
  payload: {
    requestId: string
    chatId: string
    cards: {
      image?: string, video?: string,
      body?: string, footer?: string,
      buttons: { name: string, buttonParams?: object, buttonParamsJson?: string }[]
    }[]
    text?: string
  } }
```

#### `run_command` (→ `action_ack`)
```ts
{ type: "run_command"
  payload: { requestId: string, chatId: string, command: string, contextMsgId?: string } }
```

### 1.3 Acks & errors (Node → Python, best-effort)

#### `action_ack`
Emitted for every action **except** `mark_read`/`send_presence`.
```ts
{ type: "action_ack"
  payload: {
    requestId: string
    action: string              // the action type, e.g. "send_message"
    ok: boolean
    detail: string              // human-readable status, e.g. "sent" | "deleted"
    code?: string | null        // a stable error code (Section 2) when ok=false, else null
    result?: ActionResult       // action-specific; see below
  } }
```

`ActionResult` by action (`result` shape):
```ts
send_message        → { sent: { kind: string, contextMsgId: string, messageId: string | null }[], replyTo: string | null }
react_message       → { contextMsgId: string }
delete_message      → { contextMsgId: string, messageId?: string }
kick_member         → { succeeded: number, failed: number, results: { target: object, ok: boolean, detail?: string, error?: string }[] }
run_command         → { command: string | null, error?: string }
send_quiz           → { contextMsgId: string, messageId: string | null }
send_copy_code      → object   // raw Baileys message object
send_buttons        → object   // raw Baileys message object
send_carousel       → object   // raw Baileys message object
relay_lottie_sticker→ { contextMsgId: string, messageId: string | null }
```

#### `send_ack` (legacy compatibility)
Emitted **in addition to** `action_ack` only for a **successful** `send_message`.
```ts
{ type: "send_ack", payload: { requestId: string } }
```

#### `error`
Emitted on action failure (alongside `action_ack` with `ok=false`).
```ts
{ type: "error"
  payload: {
    message: string             // short summary, e.g. "delete_message failed"
    detail: string
    code: ErrorCode             // Section 2
    requestId?: string
    action?: string
  } }
```

### 1.4 Events (Node → Python)

#### `incoming_message` (best-effort)
```ts
{ type: "incoming_message", payload: WhatsAppMessagePayload }   // Section 7
```
`payload.folderPath` is **always** present post-migration (Section 7).

#### `whatsapp_status` (reliable)
```ts
{ type: "whatsapp_status"
  payload: {
    folderPath: string
    status: WaStatus            // "open" | "connecting" | "close"
    reason?: number             // Baileys DisconnectReason code on "close"
    instanceId: string
  } }
```

### 1.5 Control events (Node → Python, reliable)

These carry their data at the **top level** of the frame (no `payload`
wrapper), preserved verbatim from the legacy protocol. `folderPath` is added at
the top level so the SDK can assert ownership.

```ts
{ type: "clear_history",            folderPath: string, chatId: string | "global" }
{ type: "set_llm2_model",           folderPath: string, chatId: string | "global", modelId: string | null }
{ type: "invalidate_llm2_model",    folderPath: string, chatId: string | "global" }
{ type: "invalidate_default_model", folderPath: string }
{ type: "invalidate_chat_settings", folderPath: string, chatId: string | "global" }
{ type: "set_subagent_enabled",     folderPath: string, chatId: string | "global", enabled: boolean }
```

### 1.6 Delivery guarantee summary

| Frame | Direction | Guarantee |
|-------|-----------|-----------|
| `hello` | Python → Node | reliable |
| `hello_ack` | Node → Python | reliable |
| all actions | Python → Node | best-effort |
| `action_ack`, `send_ack`, `error` | Node → Python | best-effort |
| `incoming_message` | Node → Python | best-effort |
| `whatsapp_status` | Node → Python | reliable |
| all control events (1.5) | Node → Python | reliable |

---

## 2. Error Codes

`ErrorCode` is one of the following stable strings. These appear in the `code`
field of `error` frames and `action_ack` (when `ok=false`).

| Code | Meaning | Produced by |
|------|---------|-------------|
| `not_found` | Target message/resource not found (e.g. unresolved `contextMsgId`). | `delete_message`, `react_message`, `send_message` (`replyTo`), `run_command` |
| `not_group` | Action requires a group chat but was sent to a private chat. | `kick_member` |
| `permission_denied` | Bot lacks the required role (admin/superadmin). | `kick_member` |
| `invalid_target` | `senderRef` / `contextMsgId` malformed or unresolvable; or unsupported action type. | `send_message`, `kick_member`, `run_command`, unknown actions |
| `send_failed` | Underlying WhatsApp send failed (network, media, rate-limit, socket not ready). | any send-capable action |
| `timeout` | Operation timed out (media download/send deadline, **or** SDK-side ack wait expired). | any awaited action |

`timeout` is also raised **client-side by the SDK** when an action's pending-ack
future expires (Section 3) — no `error` frame is involved in that case.

Unknown/absent `code` on an `error` frame → SDK maps to the base `WaSocketError`.

---

## 3. request_id Format

```
"<tag>-<unix_ms>-<seq6>"
```
- `<tag>`: a short action tag, e.g. `send`, `react`, `delete`, `kick`, `quiz`,
  `copy`, `cmd`, `sticker`, `subagent_attach`, `mute_del`. (It is a category
  tag, not necessarily the exact action `type`.)
- `<unix_ms>`: `int(time.time() * 1000)` at generation.
- `<seq6>`: a process-global monotonic counter, zero-padded to 6 digits
  (`f"{next(counter):06d}"`). The counter never resets within a process and is
  shared across all `WaSocket` instances in that process.

Example: `send-1715097600000-000042`.

- **Generated by:** Python (the `WaSocket`/`correlation.py`). Node only echoes
  `requestId` back in `action_ack`/`send_ack`/`error`.
- **Uniqueness:** unique per process for the process lifetime (ms + monotonic
  seq). Not globally unique across restarts (acceptable: correlation is
  in-process and ephemeral).
- **Expiry:** a `requestId`'s pending-ack future expires after the SDK's
  per-request ack timeout (default **30s**, configurable). After expiry the
  future is rejected with a `timeout` `WaSocketError` and any later ack bearing
  that `requestId` is ignored.

---

## 4. WaSocket Python Interface

`make_wa_socket(folder_path: str) -> WaSocket`

```python
class WaSocket:
    # --- properties ---
    @property
    def folder_path(self) -> str: ...          # the tenant folder this socket serves
    @property
    def is_connected(self) -> bool: ...         # True iff transport is OPEN and handshake done

    # --- lifecycle ---
    async def connect(self, node_url: str = "ws://localhost:3000") -> None:
        # Opens the transport, sends `hello`, awaits `hello_ack`. Idempotent if
        # already connected. Raises ConnectionError-derived WaSocketError on
        # unrecoverable connect failure (transport keeps retrying on transient).
    async def disconnect(self) -> None:
        # Graceful close: flush reliable queue if OPEN, stop heartbeat/reconnect,
        # close the socket. Never raises.

    # --- event registration (decorator; sync registration, handlers may be async) ---
    def on(self, event: str) -> Callable[[Handler], Handler]:
        # event ∈ {"message","status","ready","error",
        #          "action_ack","send_ack",
        #          "clear_history","set_llm2_model","invalidate_llm2_model",
        #          "invalidate_default_model","invalidate_chat_settings",
        #          "set_subagent_enabled"}
        # Handler payloads:
        #   "message" -> WhatsAppMessage (Section 7)
        #   "status"  -> dict {"status": WaStatus, "reason": int|None, "folderPath": str}
        #   "ready"   -> None
        #   "error"   -> WaSocketError
        #   "action_ack"/"send_ack" -> AckResult (Section 6)
        #   control events -> dict (top-level control-event fields, Section 1.5)

    # --- actions (all async) ---
    # Each awaits the matching action_ack and returns its `result` dict,
    # or raises a WaSocketError subclass (Section 2) on an `error` frame /
    # ack with ok=False, or `timeout` on ack-wait expiry.

    async def send_message(self, destination: str, text: str | None = None, *,
                           reply_to: str | None = None,
                           attachments: list[dict] | None = None,
                           mentions: list[str] | None = None) -> dict: ...
        # returns ActionResult.send_message; raises NotFoundError (bad reply_to),
        # SendFailedError, InvalidTargetError, TimeoutError

    async def send_quiz(self, destination: str, question: str,
                        choices: list[dict], *,
                        reply_to: str | None = None,
                        footer: str | None = None) -> dict: ...
        # raises SendFailedError, InvalidTargetError, TimeoutError

    async def react(self, destination: str, msg_id: str, emoji: str) -> dict: ...
        # msg_id is a contextMsgId; raises NotFoundError, SendFailedError, TimeoutError

    async def delete_message(self, destination: str, msg_id: str) -> dict: ...
        # raises NotFoundError, PermissionDeniedError, SendFailedError, TimeoutError

    async def kick(self, group_id: str, members: list[dict], *,
                   mode: str = "partial_success") -> dict: ...
        # members: [{"senderRef": str, "anchorContextMsgId": str}, ...]
        # raises NotGroupError, PermissionDeniedError, InvalidTargetError,
        # SendFailedError, TimeoutError

    async def send_presence(self, chat_id: str, presence: str) -> None: ...
        # presence ∈ {"composing","paused"}; FIRE-AND-FORGET, no ack, never returns a result

    async def mark_read(self, chat_id: str, message_id: str,
                        participant: str | None = None) -> None: ...
        # FIRE-AND-FORGET, no ack

    async def send_buttons(self, destination: str, body: str,
                           buttons: list[dict], *, reply_to: str | None = None) -> dict: ...
        # raises SendFailedError, TimeoutError

    async def send_carousel(self, destination: str, cards: list[dict], *,
                            body: str | None = None) -> dict: ...
        # raises SendFailedError, TimeoutError

    async def send_copy_code(self, destination: str, code: str, *,
                             reply_to: str | None = None) -> dict: ...
        # raises SendFailedError, TimeoutError

    async def send_sticker(self, destination: str, path: str, *,
                           reply_to: str | None = None) -> dict: ...
        # builds a send_message frame with a sticker attachment;
        # raises SendFailedError, TimeoutError

    async def run_command(self, chat_id: str, command: str, *,
                          context_msg_id: str | None = None) -> dict: ...
        # returns ActionResult.run_command; raises InvalidTargetError, TimeoutError
```

Notes:
- `mark_read` and `send_presence` are the **only** fire-and-forget methods.
- All other action methods **await the ack** (Section 1.2 / D3) and return the
  `result` dict (or raise). The SDK **also** re-emits `action_ack`/`send_ack` as
  events so an agent can additionally observe them.

---

## 5. TypeScript Types (Node side — `src/protocol/types.ts`)

```ts
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
// IncomingMessagePayload — see Section 7 (WhatsAppMessagePayload).

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
export interface AccountEntry {
  folderPath: string;                 // account key
  ctx: AccountContext;                // per-account caches/identifiers/sendQueue (Step 16)
  sock?: import("baileys").WASocket;  // live Baileys socket, undefined until created
  client?: import("ws").WebSocket;    // bound Python client, undefined when disconnected
  waStatus: WaStatus;
  reliableQueue: OutboundFrame[];     // per-account reliable queue (bound MAX_RELIABLE_QUEUE)
}

export interface BaileysFactoryOptions {
  folderPath: string;                 // tenant folder; auth dir = `${folderPath}/auth`
  onStatusChange?: (status: WaStatus, reason?: number) => void;
  printQr?: boolean;                  // default true
}
```

`AccountContext` is the per-account state holder (defined in Step 16); its
concrete fields are an internal Node detail and intentionally **not** part of
the wire contract.

---

## 6. Python Dataclasses (`python/wasocket/protocol.py`)

All frozen. These mirror Section 5 field-for-field. `to_frame()` produces the
`{type, payload}` (or top-level control) dict; `from_frame(dict)` parses.

```python
from dataclasses import dataclass
from typing import Optional, Any

# ---- handshake ----
@dataclass(frozen=True)
class Hello:
    folder_path: str
    protocol_version: str = "2.0"

@dataclass(frozen=True)
class HelloAck:
    folder_path: str
    wa_status: str           # "open" | "connecting" | "close"

# ---- actions Python SENDS ----
@dataclass(frozen=True)
class SendMessageAction:
    request_id: str; chat_id: str
    text: Optional[str] = None
    reply_to: Optional[str] = None
    attachments: Optional[list[dict]] = None

@dataclass(frozen=True)
class ReactMessageAction:
    request_id: str; chat_id: str; context_msg_id: str; emoji: str

@dataclass(frozen=True)
class DeleteMessageAction:
    request_id: str; chat_id: str; context_msg_id: str

@dataclass(frozen=True)
class KickMemberAction:
    request_id: str; chat_id: str
    targets: tuple[dict, ...]
    mode: str = "partial_success"
    auto_reply_anchor: bool = False

@dataclass(frozen=True)
class MarkReadAction:
    chat_id: str; message_id: str; participant: Optional[str] = None   # no request_id

@dataclass(frozen=True)
class SendPresenceAction:
    chat_id: str; type: str                                            # no request_id

@dataclass(frozen=True)
class SendQuizAction:
    request_id: str; chat_id: str; question: str
    choices: tuple[dict, ...]
    reply_to: Optional[str] = None; footer: Optional[str] = None

@dataclass(frozen=True)
class SendCopyCodeAction:
    request_id: str; chat_id: str; code: str
    display_text: str = "Copy Code"
    reply_to: Optional[str] = None; quoted_preview_text: Optional[str] = None

@dataclass(frozen=True)
class RelayLottieStickerAction:
    request_id: str; chat_id: str; lottie_payload: str; reply_to: Optional[str] = None

@dataclass(frozen=True)
class SendButtonsAction:
    request_id: str; chat_id: str; text: str
    buttons: tuple[dict, ...]; footer: Optional[str] = None

@dataclass(frozen=True)
class SendCarouselAction:
    request_id: str; chat_id: str
    cards: tuple[dict, ...]; text: Optional[str] = None

@dataclass(frozen=True)
class RunCommandAction:
    request_id: str; chat_id: str; command: str; context_msg_id: Optional[str] = None

# ---- events Python RECEIVES ----
@dataclass(frozen=True)
class WhatsAppStatusEvent:
    folder_path: str; status: str; instance_id: str; reason: Optional[int] = None

@dataclass(frozen=True)
class ClearHistoryEvent:
    folder_path: str; chat_id: str                  # chat_id may be "global"

@dataclass(frozen=True)
class SetLlm2ModelEvent:
    folder_path: str; chat_id: str; model_id: Optional[str]

@dataclass(frozen=True)
class InvalidateLlm2ModelEvent:
    folder_path: str; chat_id: str

@dataclass(frozen=True)
class InvalidateDefaultModelEvent:
    folder_path: str

@dataclass(frozen=True)
class InvalidateChatSettingsEvent:
    folder_path: str; chat_id: str

@dataclass(frozen=True)
class SetSubagentEnabledEvent:
    folder_path: str; chat_id: str; enabled: bool

# (incoming_message is parsed into WhatsAppMessage — Section 7, in wasocket/events.py)

# ---- ack / error ----
@dataclass(frozen=True)
class AckResult:
    request_id: str
    action: str
    ok: bool
    detail: str
    code: Optional[str] = None
    result: Optional[dict] = None

@dataclass(frozen=True)
class ErrorResult:
    message: str
    detail: str
    code: str                          # an ErrorCode (Section 2)
    request_id: Optional[str] = None
    action: Optional[str] = None
```

---

## 7. WhatsAppMessage Fields

Canonical inbound message model. Defined in `python/wasocket/events.py` as
`WhatsAppMessage` (the SDK's `incoming_message` payload model) and mirrored on
the Node side by `WhatsAppMessagePayload` in `src/protocol/types.ts`.

> **Not** the same as `python/bridge/history.py::WhatsAppMessage` (the agent's
> internal history representation). The collision is intentional in the prose
> but they are different types in different modules; never import one for the
> other.

`Always` = present on every `incoming_message`. `Optional` = may be absent/null.

| Field | Type | Presence | Description |
|-------|------|----------|-------------|
| `folderPath` | `str` | Always | Tenant/account this message belongs to (routing key). |
| `instanceId` | `str` | Always | Bot instance identifier. |
| `chatId` | `str` | Always | Chat JID (`…@g.us` or `…@s.whatsapp.net`). |
| `chatName` | `str` | Always | Display name of the chat. |
| `chatType` | `"group" \| "private"` | Always | Chat kind. |
| `messageId` | `str` | Always | WhatsApp native message id (`wamid…`) or synthetic id for synthetic events. |
| `contextMsgId` | `str` | Optional | 6-digit per-chat sequence (`000000`–`999999`); absent on some synthetic events. |
| `senderId` | `str` | Always | Sender JID. |
| `senderRef` | `str` | Always | Short 6-char LLM-friendly reference (e.g. `u8k2d1`). |
| `senderName` | `str` | Always | Sender display name. |
| `senderIsAdmin` | `bool` | Always | Sender is a group admin (or superadmin). |
| `senderIsSuperAdmin` | `bool` | Always | Sender is a WhatsApp community super-admin. |
| `senderIsOwner` | `bool` | Optional | Sender is a bot owner (from `BOT_OWNER_JIDS`). |
| `isGroup` | `bool` | Always | Whether the chat is a group. |
| `botIsAdmin` | `bool` | Always | Bot has admin role in the group. |
| `botIsSuperAdmin` | `bool` | Always | Bot is a community super-admin. |
| `fromMe` | `bool` | Always | Message was sent by the bot itself. |
| `contextOnly` | `bool` | Always | Enrich-context-only; do not trigger LLM1. |
| `triggerLlm1` | `bool` | Always | Whether LLM1 should process (true only for some synthetic events). |
| `timestampMs` | `int` | Always | Unix timestamp in ms. |
| `messageType` | `str` | Always | WhatsApp type, or synthetic `actionLog`/`groupParticipantsUpdate`/`botRoleChange`. |
| `text` | `str \| None` | Optional | Message text content. |
| `quoted` | `object \| None` | Optional | `{ messageId, contextMsgId, senderId, senderRef?, text, type, fromMe?, senderIsAdmin?, senderIsSuperAdmin?, mentionedParticipants? }`. |
| `attachments` | `Attachment[]` | Always (may be `[]`) | Media: `{ kind, mime, fileName, originalFileName?, size, path, isAnimated?, jpegThumbnail? }`. |
| `mentionedJids` | `str[] \| None` | Optional | Raw JIDs of mentioned participants. |
| `mentionedParticipants` | `{ jid, senderRef, name, isBot }[] \| None` | Optional | Resolved mentions (prefer over `mentionedJids`). |
| `botMentioned` | `bool` | Optional | Bot was `@`-mentioned. |
| `repliedToBot` | `bool` | Optional | Message is a direct reply to a bot message. |
| `location` | `{ degreesLatitude, degreesLongitude } \| None` | Optional | Location data. |
| `groupDescription` | `str \| None` | Optional | Group description text for context. |
| `slashCommand` | `{ command: str, args: str } \| None` | Optional | Parsed slash command. |
| `commandHandled` | `bool` | Optional | Slash command already processed by Node. |
| `groupEvent` | `{ action, participants?, actorId?, actorName?, source } \| None` | Optional | Present on `groupParticipantsUpdate`/`botRoleChange`. |
| `actionLog` | `{ action, result } \| None` | Optional | Present when `messageType === "actionLog"`. |

---

## 8. Folder Layout Convention

Every tenant folder (`folderPath`, the account key) has this exact structure:

```
<folderPath>/
  auth/                 ← Baileys multi-file auth state (per account)
  db/
    settings.db         ← chat_settings, llm_models, activation, owner_contact
    stats.db            ← chat_stats, chat_user_stats
    moderation.db       ← chat_mutes
    subagent.db         ← subagent_enabled
    stickers.db         ← stickers (per-tenant sticker catalog)
  media/                ← downloaded inbound media + staged sub-agent output
  stickers/             ← static sticker catalog files (.webp etc.)
```

### Directory-creation responsibility

| Directory | Created by |
|-----------|-----------|
| `<folderPath>/` (root) | Node — `baileysFactory.createOrResumeAccount` ensures it exists before use. |
| `auth/` | Node — `baileysFactory` (passed to `useCachedAuthState`). |
| `db/` | Node — `baileysFactory` ensures it exists; Node owns the schema (primary writer of `settings.db`/`subagent.db`/`stickers.db`). Python opens the same files under `db/` for its tenant. |
| `media/` | Node — `baileysFactory` ensures it exists; Node writes downloaded media, Python writes staged sub-agent output into the same dir. |
| `stickers/` | Node — `baileysFactory` ensures it exists. |

### Notes

- **Per-tenant DBs supersede MIGRATION_PLAN.md D2's "DBs stay shared."** Each
  account now owns its own `db/` directory, which fully isolates state and
  removes the cross-account `chatId`-collision concern D2 raised. Concretely:
  Node's `db.ts` and Python's `bridge/db.py` must resolve their SQLite paths
  under the **tenant's** `db/` directory (no global `SETTINGS_DB_PATH` etc.);
  this path wiring is performed in Step 17 (Node) and Steps 32–33 (Python).
- Auth state is never shared between tenants; deleting one tenant's `auth/`
  forces only that account to re-pair.
- Paths inside action/event payloads (`attachments[].path`, sub-agent staging)
  remain readable by both sides because `media/` lives inside the shared
  `folderPath` (Node and the agent must agree on the same absolute
  `folderPath`).
