---
sidebar_position: 9
---

# FAQ — Frequently Asked Questions

## Why isn't the bot responding to my message?

Possible causes:
- In groups, the bot doesn't always respond to every message. Try **mentioning or replying** directly to the bot.
- The bot is processing another message (visible from the typing indicator).
- Your message is too old (the bot only looks at the most recent messages).

## Why isn't my `/prompt` command working?

- In groups, **only admins** can use `/prompt`.
- Make sure the command is typed correctly (starting with `/`).
- Check if your text exceeds 4000 characters.

## How do I stop the bot from responding?

- Use `/prompt` to change the bot's behavior, or
- Group admin can remove the bot from the group

## Does the bot store my messages?

The bot stores conversation history **temporarily** to provide answer context. Use `/reset` to clear this history.

## Can the bot respond in other languages?

Yes! The bot can communicate in various languages. You can ask the bot to speak a specific language via `/prompt`, or simply chat with the bot in your preferred language.

## Why did the bot delete my message?

The bot deletes messages if:
- Permission level is set to 1 or 3
- The prompt instructs the bot to delete that type of message

Contact the group admin to find out the applicable rules.

## The bot suddenly kicked me even though I didn't break any rules?

This can happen if the moderation prompt is too aggressive. Contact the group admin to:
1. Check the prompt with `/prompt`
2. Lower the permission level with `/permission 1` or `/permission 0`
3. Fix the prompt to be more specific

## Do settings apply to all groups?

**No.** All settings (prompt, permission, reset) apply **per chat**. Settings in group A do not affect group B.
