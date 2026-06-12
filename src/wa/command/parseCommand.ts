// ---------------------------------------------------------------------------
// Slash command parsing (pure: raw text → { command, args })
// ---------------------------------------------------------------------------
//
// This module is intentionally dependency-free and registry-agnostic: it only
// splits the leading `/token` from its arguments. Alias resolution and the
// canonical-name / known-command decision live on the command descriptors in
// `commands/CommandRegistry.ts` (single source of truth).

const SLASH_CMD_RE = /^\/([a-z][a-z0-9_-]*)\b\s*([\s\S]*)/i;

/**
 * Parse a raw slash command into its lowercased token and trimmed argument
 * string. Returns `null` when the text is not a slash command. Does NOT resolve
 * aliases or validate that the token is a known command — that is the
 * registry's job (`parseSlashCommand` in CommandRegistry).
 */
function parseRawSlash(
  text: string | null,
): { command: string; args: string } | null {
  if (!text || typeof text !== 'string') return null;
  const m = text.trim().match(SLASH_CMD_RE);
  if (!m) return null;
  return {
    command: m[1].toLowerCase(),
    args: (m[2] || '').trim(),
  };
}

export { parseRawSlash };
