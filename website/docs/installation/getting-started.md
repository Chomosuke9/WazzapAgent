---
sidebar_position: 2
---

# Getting Started

## Adding the Bot to a Group

1. **Add the bot's number** to your WhatsApp group just like adding a regular member.
2. If the owner enabled activation protection, activate the group with
   `/activate <code>`. Otherwise the bot is ready immediately.
3. **Optional but important for moderation:** Make the bot a **group admin** if you want it to delete messages or kick members.

:::note
Without admin status, the bot can still chat and reply to messages, but cannot perform moderation actions (delete/kick).
:::

## How to Make the Bot an Admin

1. Open **Group Info** in WhatsApp
2. Tap the bot's name in the member list
3. Select **"Make Admin"**

## Recommended First Steps

After the bot joins the group, follow these steps in order:

1. **Check bot info** by typing `/info` in the chat — make sure the bot is detected as admin if you've already made it one.
2. **Set the bot's personality** with `/prompt <your instructions>` — this determines how the bot behaves in this group.
3. **Test it out** by greeting the bot: `@Vivy hello!`
4. If you want moderation, read the [Permission System](/usage/permission) section first before enabling it.

## How the Bot Responds in Groups

The bot has three **response modes**, configured through `/setting` or `/mode`:

### `auto` mode
- The bot **analyzes the context** of every message with AI
- Responds automatically when there's an important topic
- Suitable for groups that genuinely need an active bot
- **Uses more API tokens**

### `prefix` mode (default, optimal for busy groups)
- The bot **only responds when explicitly called:**
  - `@mention` the bot (e.g., `@Vivy hello`)
  - Reply to the bot's previous message
  - Mention the bot's name in text (e.g., "Vivy, help me")
  - A new member joins (configurable)
- **More token-efficient**, faster responses
- Configure triggers with `/trigger`

### `hybrid` mode
- Checks prefix triggers first
- Falls back to LLM1 when no prefix trigger matches
- Useful when you want predictable direct calls plus selective proactive replies

In **private chats**, the bot responds to every accepted message regardless of
mode. The owner can disable private-chat ingress entirely with
`PRIVATE_CHAT_ENABLED=false`.

:::tip
For busy groups, use **prefix mode** so the bot isn't too noisy and saves tokens. Open `/setting` or use `/mode`, then configure its triggers:
```
/mode prefix                    # Or choose the mode from /setting
/trigger reply on               # Respond when replied to
/trigger tag on                 # Respond when tagged
```
:::
