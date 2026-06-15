// Shared scope parsing for per-chat configuration commands.
//
// Config commands (/mode, /trigger, /permission, /prompt, /idle,
// /announcement, /subagent) accept an optional leading scope token:
//   - `global`  → overwrite EVERY chat (setGlobal* — no exception)
//   - `default` → write ONLY the __global__ fallback row (setDefault*), so
//     chats that have NOT set their own value follow it; touched chats keep
//     their own. (feature 3)
// Both scopes are owner-only and broadcast an `invalidate_chat_settings`
// with `chatId: "global"` so the Python bridge drops all cached values.

export type ConfigScope = "chat" | "global" | "default";

/** Resolve the leading token (already lower-cased) to a {@link ConfigScope}. */
export function parseConfigScope(token: string | undefined): ConfigScope {
  if (token === "global") return "global";
  if (token === "default") return "default";
  return "chat";
}

/** Human-readable suffix appended to a command's confirmation reply. */
export function scopeSuffix(scope: ConfigScope): string {
  if (scope === "global") return " globally";
  if (scope === "default") return " by default";
  return "";
}
