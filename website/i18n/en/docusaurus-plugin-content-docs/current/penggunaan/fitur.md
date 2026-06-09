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

## Prompt & Permission Settings

Admins can configure bot behavior using commands:
- `/prompt <text>` — Set custom instructions for the bot in this chat
- `/permission <0-3>` — Set moderation permission level (delete/kick)
