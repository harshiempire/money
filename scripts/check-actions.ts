/**
 * Fails when a "use server" file exports anything that isn't wrapped in
 * defineAction / definePublicAction / asFormAction
 * (src/lib/action/define-action.ts). Detection lives in
 * scripts/lib/server-action-exports.ts (Bun's TypeScript scanner plus a
 * declaration check), with regression tests next to it.
 *
 * Why: defineAction is where authentication, input decoding, and
 * production-safe error results live. A bare `export async function` in a
 * "use server" file skips all three — and its thrown error messages are
 * replaced by a digest in production.
 *
 * LEGACY lists files not migrated yet. Each migration PR removes its file;
 * the script also fails if a listed file is already clean, so the list can
 * only shrink.
 *
 * Usage: bun run check:actions
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isUseServerFile, unwrappedExports } from "./lib/server-action-exports";

const LEGACY = new Set([
  // Follow-ups, not in this PR.
  "src/app/assistant/actions.ts",
  "src/app/assistant/proposed-tag-actions.ts",
  "src/app/assistant/tag-actions.ts",
  "src/app/connections/actions.ts",
  "src/app/talk/actions.ts",
]);

const problems: string[] = [];
const seen = new Set<string>();

const files = readdirSync("src", { recursive: true, encoding: "utf8" })
  .filter((f) => /\.tsx?$/.test(f))
  .map((f) => join("src", f).split("\\").join("/"));

for (const path of files) {
  const text = readFileSync(path, "utf8");
  if (!isUseServerFile(text)) continue;
  seen.add(path);

  const bare = unwrappedExports(text);
  if (LEGACY.has(path)) {
    if (bare.length === 0) {
      problems.push(`${path}: fully migrated — remove it from LEGACY in scripts/check-actions.ts`);
    }
    continue;
  }
  for (const name of bare) {
    problems.push(`${path}: \`${name}\` is not a defineAction / definePublicAction / asFormAction result — wrap it`);
  }
}

// A LEGACY path that doesn't exist here is fine: talk/actions.ts lives on its
// own branch until it merges.

if (problems.length > 0) {
  console.error("check:actions failed:\n" + problems.map((p) => `  - ${p}`).join("\n"));
  process.exit(1);
}
console.log(
  `check:actions ok — ${seen.size} "use server" file(s), ${[...LEGACY].filter((p) => seen.has(p)).length} still on the legacy list`,
);
