---
sidebar_position: 3
---

# How to Get Your LID

WhatsApp now often identifies accounts with an LID (`user@lid`) instead of a phone JID (`user@s.whatsapp.net`). Use one of the methods below when `BOT_OWNER_JIDS` does not detect your phone JID.

## Using `/info`

:::note
This method requires the bot to be online. If it is not running yet, start it from the [installation guide](/installation).
:::

Send `/info` from the owner number. The response shows the current user IDs WhatsApp exposes for that account.

![slash info](/img/slash_info.jpg)

## Using Meta AI

:::note
This method requires either two accounts or another person to mention the owner account.
:::

1. Open a group that contains the owner account and `@Meta AI` (advanced group privacy must be disabled).
2. Send:

```txt
@Meta Ai Give me this person id's @<owner number>
```

3. Meta AI should return an identifier similar to the screenshot below.

![Meta AI method success](/img/meta_ai_method.jpg)

4. The `@4131402...` value is the LID for the mentioned account. Save it as `<number>@lid`.

## Confirm Owner Detection

After updating `BOT_OWNER_JIDS`, send `/info` again and check the `Owner bot: ...` line.

![slash info](/img/slash_info.jpg)
