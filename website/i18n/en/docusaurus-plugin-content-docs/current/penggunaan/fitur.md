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

## Response Mode (Auto vs Prefix)

The bot has **two configurable response modes**:

- **`auto`** (default) — The bot analyzes the context of every message and responds automatically
- **`prefix`** (token-saving) — The bot only responds when called: `@mention`, reply, or its name is mentioned

The response mode is configured through the interactive **`/setting`** menu (replacing the old `/mode` command). Triggers for prefix mode are still set with `/trigger`:
```
/setting            # Open the menu, then choose the response mode
/trigger reply on   # Configure response triggers (prefix mode)
```

## Prompt, Mode, & Permission Settings

Admins and the bot owner can configure bot behavior:
- `/prompt <text>` — Set custom instructions for the bot in this chat
- `/permission <0-3>` — Set moderation permission level (delete/mute/kick)
- `/setting` — Change the response mode & other per-chat settings
- `/trigger <type>` — Configure triggers in prefix mode
- `/dashboard` — View usage statistics
