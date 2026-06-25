// ---------------------------------------------------------------------------
// Shared permission DSL
// ---------------------------------------------------------------------------
//
// A `permission` is a boolean expression over atoms, combined with `and` / `or`
// and optional parentheses, e.g. `"private or (isGroup and isAdmin) or isOwner"`.
// `and` binds tighter than `or`; parentheses override precedence. Atom names are
// case-insensitive and accept both the short and `is*`/camel forms.
//
// This module is CONTEXT-AGNOSTIC: it owns the atom vocabulary, the
// parser/evaluator, init-time validation, and the human-readable labels used in
// the auto-generated denial reply. Atom RESOLUTION (mapping an atom name to a
// truth value for a specific invocation) is per-context and stays with each
// registry — `CommandRegistry` resolves against a `CommandListenerContext`,
// `ButtonRegistry` against a `ButtonContext`.

// Atom alias → canonical atom. Keys are lowercased.
export const PERMISSION_ATOMS: Record<string, string> = {
  public: "public",
  owner: "owner",
  isowner: "owner",
  admin: "admin",
  isadmin: "admin",
  group: "group",
  isgroup: "group",
  private: "private",
  isprivate: "private",
  from_me: "from_me",
  fromme: "from_me",
};

export interface PermissionAtoms {
  isOwner: boolean;
  isAdmin: boolean;
  isGroup: boolean;
  isPrivate: boolean;
  fromMe: boolean;
}

/** Resolve a canonical atom name against a plain atom struct. */
export function resolveAtom(
  name: string,
  atoms: PermissionAtoms,
): boolean {
  switch (PERMISSION_ATOMS[name.toLowerCase()]) {
    case "public":
      return true;
    case "owner":
      return atoms.isOwner;
    case "admin":
      return atoms.isAdmin;
    case "group":
      return atoms.isGroup;
    case "private":
      return atoms.isPrivate;
    case "from_me":
      return atoms.fromMe;
    default:
      return false;
  }
}

/**
 * Tokenise + evaluate a permission expression via recursive descent.
 * Grammar: or := and ("or" and)* ; and := primary ("and" primary)* ;
 * primary := "(" or ")" | atom. `atom(name)` supplies each atom's truth value;
 * the parser throws on malformed input (used by both eval and init validation).
 */
export function evalPermissionExpr(
  expr: string,
  atom: (name: string) => boolean,
): boolean {
  const tokens = expr.match(/\(|\)|[A-Za-z_]+/g) ?? [];
  let pos = 0;
  const peek = (): string | undefined => tokens[pos];
  const isKeyword = (t: string | undefined, kw: string): boolean =>
    typeof t === "string" && t.toLowerCase() === kw;

  function parsePrimary(): boolean {
    const t = tokens[pos++];
    if (t === undefined) throw new Error("unexpected end of expression");
    if (t === "(") {
      const v = parseOr();
      if (tokens[pos++] !== ")") throw new Error('missing ")"');
      return v;
    }
    if (t === ")" || isKeyword(t, "and") || isKeyword(t, "or")) {
      throw new Error(`unexpected token "${t}"`);
    }
    return atom(t);
  }

  function parseAnd(): boolean {
    let v = parsePrimary();
    while (isKeyword(peek(), "and")) {
      pos++;
      // Always parse the operand (to consume tokens) before combining.
      const r = parsePrimary();
      v = v && r;
    }
    return v;
  }

  function parseOr(): boolean {
    let v = parseAnd();
    while (isKeyword(peek(), "or")) {
      pos++;
      const r = parseAnd();
      v = v || r;
    }
    return v;
  }

  const result = parseOr();
  if (pos !== tokens.length) throw new Error(`trailing token "${tokens[pos]}"`);
  return result;
}

/**
 * Whether a permission expression is satisfied, given a per-context atom
 * resolver. The parser/evaluator is context-agnostic; `resolveAtom` supplies
 * the truth value of each atom for a concrete invocation (a command's
 * `CommandListenerContext`, a button tap's `ButtonContext`, …).
 */
export function isPermitted(
  permission: string,
  resolveAtom: (name: string) => boolean,
): boolean {
  return evalPermissionExpr(permission, resolveAtom);
}

/**
 * Validate a permission expression at registry-init time: throws on unknown
 * atoms or malformed structure (unbalanced parens, dangling operators) so a
 * typo fails fast at boot rather than silently denying at runtime.
 */
export function validatePermission(permission: string, canonical: string): void {
  try {
    evalPermissionExpr(permission, (name) => {
      if (!(name.toLowerCase() in PERMISSION_ATOMS)) {
        throw new Error(`unknown atom "${name}"`);
      }
      return false;
    });
  } catch (err) {
    throw new Error(
      `Invalid permission "${permission}" for "${canonical}": ${(err as Error).message}`,
    );
  }
}

// Human-readable label per canonical atom (for the auto-generated denial).
export const PERMISSION_LABELS: Record<string, string> = {
  public: "everyone",
  owner: "the bot owner",
  admin: "group admins",
  group: "group members",
  private: "private chats",
  from_me: "the bot",
};

/**
 * Build a short "all-in-one" phrase of who may use a feature, derived from the
 * atoms present in its permission expression (the boolean structure is
 * intentionally flattened — this is a hint, not a precise spec). Used in the
 * denial reply so the message always reflects the declarative permission.
 */
export function describePermission(permission: string): string {
  const seen: string[] = [];
  for (const tok of permission.match(/[A-Za-z_]+/g) ?? []) {
    const lower = tok.toLowerCase();
    if (lower === "and" || lower === "or") continue;
    const canonical = PERMISSION_ATOMS[lower];
    if (canonical && !seen.includes(canonical)) seen.push(canonical);
  }
  if (seen.includes("public") || seen.length === 0) return "everyone";
  // `admin` already implies a group, so drop the redundant bare `group`.
  const atoms = seen.includes("admin")
    ? seen.filter((a) => a !== "group")
    : seen;
  const labels = atoms.map((a) => PERMISSION_LABELS[a] ?? a);
  if (labels.length === 1) return labels[0];
  return `${labels.slice(0, -1).join(", ")} or ${labels[labels.length - 1]}`;
}
