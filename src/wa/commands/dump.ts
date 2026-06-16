import logger from "../../logger.js";
import type { CommandContext, CommandHandler } from "../command/CommandContext.js";

// `/dump` is intentionally a NO-OP on the Node side. The full LLM-context dump
// (system prompt + group description + chat state + history + current message)
// is built and sent as a `.txt` attachment by the Python bridge in
// `python/bridge/agent/batch_processor.py` (the `cmd_name == "dump"` branch),
// because it needs the full LLM state that only the bridge holds.
//
// This handler exists solely so the command registry recognises `/dump`:
// `parseSlashCommand("/dump")` must resolve to a canonical name for the inbound
// payload to carry `slashCommand.command = "dump"` (and `commandHandled = true`)
// to the bridge. Without a registered descriptor, `parseSlashCommand` returns
// `null`, the bridge never sees the command, and the Python dump branch is
// dead code — which is exactly the bug this fixes. Do NOT post anything to the
// chat here; the bridge owns the reply.
async function handleDump({ chatId }: CommandContext): Promise<void> {
  logger.debug({ chatId }, "/dump recognised on gateway; bridge builds the dump");
}

export { handleDump };

export const dumpCommand: CommandHandler = {
  commands: ["dump"],
  description:
    "Ekspor konteks LLM lengkap (system prompt, deskripsi grup, state chat, riwayat, dan pesan saat ini) sebagai berkas .txt.",
  permission: "public",
  run: (_sock, _message, ctx) => handleDump(ctx),
};
