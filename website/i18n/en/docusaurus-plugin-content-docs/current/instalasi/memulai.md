---
sidebar_position: 2
---

# Getting Started

## Adding the Bot to a Group

1. **Add the bot's number** to your WhatsApp group just like adding a regular member.
2. The bot will automatically activate and be ready to use.
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
4. If you want moderation, read the [Permission System](/penggunaan/permission) section first before enabling it.

## How the Bot Responds in Groups

In busy groups, the bot **doesn't respond to every message**. The bot will respond if:

- The message **mentions the bot** explicitly (e.g., `@Vivy`)
- The message is a **reply** to the bot's previous message
- The bot determines there's important context that needs a response
- There's an **important event** like a new member joining

In **private chats**, the bot always responds to every message.
