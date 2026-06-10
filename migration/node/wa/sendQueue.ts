/**
 * sendQueue.js — Per-JID serialization for outbound WhatsApp sends.
 *
 * Problem: Baileys uses a shared internal pending-ack map on the socket.
 * When two concurrent calls both do `sock.relayMessage(jid, ...)` or
 * `sock.sendMessage(jid, ...)` to the **same JID**, the second call can
 * race with the ack handler of the first, causing one of them to time out
 * or be silently dropped by WhatsApp.
 *
 * This is observable when `/broadcast` runs while the LLM is generating a
 * reply for a group: broadcast sends to group X via `sendRichMessage` →
 * `sock.relayMessage(groupX, ...)`, while simultaneously `dispatchCommand`
 * for a `send_message` from Python also does `sock.sendMessage(groupX, ...)`
 * — both racing to the same JID.
 *
 * Solution: a lightweight per-JID async queue (implemented as a promise
 * chain). All callers that want to send to a given JID must acquire the
 * queue for that JID first. Sends to **different** JIDs still run in
 * parallel.
 *
 * As of Step 16 the queue map lives on the {@link AccountContext} (passed as the
 * first argument) instead of a module global, so two accounts serialize the
 * same `chatId` independently.
 *
 * Usage:
 *   import { withJidQueue } from './sendQueue.js';
 *   const result = await withJidQueue(ctx, jid, () => sock.sendMessage(jid, ...));
 */
import type { AccountContext } from '../account/accountContext.js';

/**
 * Run `fn` exclusively relative to all other calls with the same `jid` within
 * the same account. Calls for different JIDs (or different accounts) run
 * concurrently.
 */
function withJidQueue<T>(ctx: AccountContext, jid: string, fn: () => Promise<T>): Promise<T> {
  const jidQueues = ctx.jidQueues;
  const prev = jidQueues.get(jid) ?? Promise.resolve();
  let resolveSlot!: () => void;
  const slot = new Promise<void>((res) => { resolveSlot = res; });
  jidQueues.set(jid, slot);

  // After `prev` settles (regardless of success/failure), run `fn` and
  // then release our slot so the next waiter can proceed.
  const result = prev.then(() => fn()).finally(() => {
    // Only delete the entry if it still points to our slot — a newer call
    // may have already chained a new promise onto it.
    if (jidQueues.get(jid) === slot) {
      jidQueues.delete(jid);
    }
    resolveSlot();
  });

  return result;
}

export { withJidQueue };
