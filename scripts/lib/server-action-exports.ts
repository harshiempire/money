/**
 * Finds exports of a "use server" file that are not wrapped in defineAction /
 * definePublicAction / asFormAction. Used by scripts/check-actions.ts.
 *
 * Export names come from Bun's own TypeScript scanner (every value export:
 * declarations, `export { a as b }`, `export default`, re-exports; type-only
 * exports are erased and ignored). Each one must resolve to a local `const`
 * whose initializer is a call to one of the wrappers. Anything that can't be
 * proven wrapped — a default export, a re-export from another module, a
 * function, a `let` — is reported.
 */

const WRAPPERS = ["defineAction", "definePublicAction", "asFormAction"] as const;

type BunTranspiler = { scan(code: string): { exports: string[] } };
function scanExports(source: string): string[] {
  const BunGlobal = (globalThis as unknown as {
    Bun?: { Transpiler: new (o: { loader: "ts" | "tsx" }) => BunTranspiler };
  }).Bun;
  if (!BunGlobal) throw new Error("server-action-exports needs the Bun runtime (bun run …)");
  return new BunGlobal.Transpiler({ loader: "tsx" }).scan(source).exports;
}

/** True when the file's directive prologue contains "use server". */
export function isUseServerFile(source: string): boolean {
  let i = 0;
  const n = source.length;
  for (;;) {
    while (i < n && /\s/.test(source[i])) i++;
    if (source.startsWith("//", i)) {
      const end = source.indexOf("\n", i);
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (source.startsWith("/*", i)) {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    const quote = source[i];
    if (quote !== '"' && quote !== "'") return false;
    const close = source.indexOf(quote, i + 1);
    if (close === -1) return false;
    const directive = source.slice(i + 1, close);
    if (directive === "use server") return true;
    i = close + 1;
    while (i < n && /[ \t]/.test(source[i])) i++;
    if (source[i] === ";") i++;
  }
}

/** Local names behind `export { local as exported }` clauses (no `from`). */
function exportAliases(source: string): { local: Map<string, string>; reexported: Set<string> } {
  const local = new Map<string, string>();
  const reexported = new Set<string>();
  const clause = /export\s+(type\s+)?\{([^}]*)\}\s*(from\s*['"][^'"]+['"])?/g;
  for (const m of source.matchAll(clause)) {
    if (m[1]) continue; // `export type { … }`
    for (const part of m[2].split(",")) {
      const spec = part.trim();
      if (!spec || spec.startsWith("type ")) continue;
      const [from, , to] = spec.split(/\s+/);
      const exported = to ?? from;
      if (m[3]) reexported.add(exported);
      else local.set(exported, from);
    }
  }
  return { local, reexported };
}

/**
 * The initializer text of `const <name> … = <initializer>`, finding the first
 * `=` at nesting depth 0 that isn't part of `=>`, `==`, `<=`, `>=` or `!=`
 * (type annotations like `(i: number) => Promise<void>` contain `=>`).
 */
function constInitializer(source: string, name: string): string | null {
  const decl = new RegExp(`(?:^|[\\n;])\\s*(?:export\\s+)?const\\s+${name}\\b`, "g");
  const m = decl.exec(source);
  if (!m) return null;
  let i = m.index + m[0].length;
  let depth = 0;
  for (; i < source.length; i++) {
    const c = source[i];
    const next = source[i + 1];
    if (c === "=" && next === ">") { i++; continue; }
    if ("([{<".includes(c)) depth++;
    else if (")]}>".includes(c)) depth--;
    else if (c === "=" && depth === 0 && next !== "=" && !"<>!".includes(source[i - 1])) {
      return source.slice(i + 1).trimStart();
    }
    else if ((c === ";" || c === "\n") && depth === 0 && /^\s*(export|const|let|var|function|class)\b/.test(source.slice(i + 1))) {
      return null;
    }
  }
  return null;
}

function isWrapped(initializer: string | null): boolean {
  if (!initializer) return false;
  return WRAPPERS.some((w) => new RegExp(`^${w}\\s*\\(`).test(initializer));
}

/** Names of exports that aren't provably a wrapped server action. */
export function unwrappedExports(source: string): string[] {
  const { local, reexported } = exportAliases(source);
  const problems: string[] = [];
  for (const exported of scanExports(source)) {
    if (exported === "default" || reexported.has(exported)) {
      problems.push(exported);
      continue;
    }
    const name = local.get(exported) ?? exported;
    if (!isWrapped(constInitializer(source, name))) problems.push(exported);
  }
  return problems.sort();
}
