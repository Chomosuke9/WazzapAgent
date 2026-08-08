---
sidebar_position: 7
---

# Bot Features

## Reading Images & Media

The bot can **understand and describe** images, photos, stickers, and documents sent to the chat. Just send an image and the bot will understand the context automatically.

**Limitations:**
- Maximum **2 files** per message processed
- Maximum total size **5 MB**

## Blue Check Mark (Read Receipt)

After the bot finishes processing your message (deciding whether to respond or not), the bot will automatically **blue-check** your message. This indicates the bot has "read" and processed your message.

## Typing Indicator

When the bot is composing a reply, you'll see **"[Bot Name] is typing..."** — just like when a friend is writing a message.

## Memory / Conversation Context

The bot **remembers the context** of the last few messages, so:
- The bot knows what was discussed previously
- The bot can answer follow-up questions without repeating context

Use `/reset` to clear this memory and start fresh.

## Reply to Messages

The bot **replies** to specific messages when responding, making it clear which message is being addressed — especially useful in busy groups.

## New Member Detection

The bot automatically **detects when a new member** joins the group and can greet them if the prompt is configured to do so.

## Response Modes

The bot has **three configurable response modes**:

- **`prefix`** (default, token-saving) — The bot only responds when called: `@mention`, reply, or its name is mentioned
- **`auto`** (auto) — The bot analyzes the context of every message and responds automatically
- **`hybrid`** — Prefix triggers take priority, then LLM1 decides whether to respond when no trigger matches

The response mode can be configured through the interactive **`/setting`** menu
or the text-based **`/mode`** command. Text commands are useful when interactive
menus do not render on the caller's WhatsApp client. Triggers for prefix and
hybrid modes are set with `/trigger`:
```
/setting            # Open the interactive menu
/mode hybrid        # Or set the mode directly
/trigger reply on   # Configure response triggers
```

Use `/compat auto|full|semi|safe` to control interactive-message compatibility.
`safe` mode uses plain text and works on WhatsApp Web/Desktop.

## Prompt, Mode, & Permission Settings

Admins and the bot owner can configure bot behavior:
- `/prompt <text>` — Set custom instructions for the bot in this chat
- `/permission <0-3>` — Configure bot moderation: 0 none, 1 delete, 2 delete+mute, 3 delete+mute+kick; human admins may use `/group` at any level
- `/setting` — Change the response mode and other per-chat settings
- `/mode <auto|prefix|hybrid>` — Change the response mode without a menu
- `/model [id]` — List or switch the model without a menu
- `/compat <mode>` — Tune interactive messages for the caller's device
- `/trigger <type>` — Configure triggers in prefix mode
- `/dashboard` — View usage statistics
