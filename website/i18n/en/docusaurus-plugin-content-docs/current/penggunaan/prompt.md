---
sidebar_position: 5
---

# Setting Up Prompts

A prompt is a "secret instruction" that determines **who the bot is** and **what it should do**. This is the most powerful feature of WazzapAgents.

## How It Works

When you type `/prompt <text>`, the instruction is saved for this chat and sent to the AI every time the bot is about to respond. The bot will behave according to the instructions you provide.

## Good Prompt Structure

```
[Who the bot is / name and role]
[Language to use]
[What it should do]
[What it should NOT do]
[Special rules]
```

## Tips for Writing Prompts

1. **Be specific** — The more detailed the instructions, the more consistent the bot's behavior
2. **Use imperative verbs** — "Reply with...", "Never...", "Always..."
3. **State limitations** — What the bot can and cannot do
4. **Define the tone** — Formal, casual, slang, etc.
5. **For moderation** — Clearly state when the bot is allowed to act

## Supported WhatsApp Text Formatting

The bot can use the following WhatsApp text formatting in its responses:

| Format | Result |
|--------|--------|
| `*text*` | **bold** |
| `_text_` | *italic* |
| `~text~` | ~~strikethrough~~ |
| `` `text` `` | `code` |
| `> text` | quote |

## Setting Moderation Permissions

In addition to prompts, admins can also configure bot moderation permissions using the `/permission` command:

- `/permission 0` — Default, moderation disabled
- `/permission 1` — Delete messages only
- `/permission 2` — Kick members only
- `/permission 3` — Full moderation (delete and kick)

See the [Permission](./permission.md) page for full details.
