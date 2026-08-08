---
sidebar_position: 9
---

# FAQ — Frequently Asked Questions

## Why isn't the bot responding to my message?

Possible causes:
- **Prefix mode is active** — The bot only responds to enabled triggers. Check it with `/setting` or `/mode`, then inspect `/trigger`.
- **The chat is not activated** — When activation is required, use a valid `/activate <code>` for this chat type.
- **Private chats are disabled** — The owner may have set `PRIVATE_CHAT_ENABLED=false`.
- **WhatsApp is reconnecting or unpaired** — A healthy bridge connection does not by itself mean the tenant's WhatsApp socket is open; check the control panel.
- In groups, the bot doesn't always respond to every message. Try **mentioning or replying** directly to the bot.
- The bot is processing another message (visible from the typing indicator).
- Your message is too old (the bot only looks at the most recent messages).

## Why isn't my `/prompt` command working?

- In groups, **only admins** can use `/prompt`.
- Make sure the command is typed correctly (starting with `/`).
- Check if your text exceeds 4000 characters.

## How do I stop the bot from responding?

- Use `/mode prefix` and disable unwanted triggers, or adjust `/prompt`, or
- Group admin can remove the bot from the group

## Does the bot store my messages?

The bot stores conversation history **temporarily** to provide answer context. Use `/reset` to clear this history.

## Can the bot respond in other languages?

Yes! The bot can communicate in various languages. You can ask the bot to speak a specific language via `/prompt`, or simply chat with the bot in your preferred language.

## Why did the bot delete my message?

The bot deletes messages if:
- Permission level is set to 1 or higher (level 1, 2, or 3)
- The prompt instructs the bot to delete that type of message

Contact the group admin to find out the applicable rules.

## The bot suddenly kicked me even though I didn't break any rules?

This can happen if the moderation prompt is too aggressive. Contact the group admin to:
1. Check the prompt with `/prompt`
2. Lower the permission level with `/permission 1` or `/permission 0`
3. Fix the prompt to be more specific

## Do settings apply to all groups?

Chat settings are isolated by default, so changing a normal `/prompt`,
`/permission`, `/mode`, or `/reset` only affects that chat. The bot owner can
explicitly use supported `global` or `default` scopes, and bot-wide settings in
`/bot-conf` apply across chats within that tenant. Separate tenants remain
isolated.
