#!/usr/bin/env node
/**
 * Supply-chain preflight. Runs before `next dev` / `next build` (package.json,
 * vercel.json) and in CI, and refuses to continue if the repo carries the
 * footprints of the config-injection worm that hit this repo on 2026-09-25
 * (docs/security/2026-09-25-polinrider-incident.md).
 *
 * It must run BEFORE Next loads postcss/next/tailwind configs: that load is
 * what executes an injected payload. It only reads files — never imports or
 * evaluates them — and has no dependencies, so it is safe on a poisoned tree.
 *
 * Patterns are written as regexes on purpose: this file must not itself
 * contain the literal campaign markers, or public scanners that search
 * GitHub for them would report this repo as infected.
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SKIP_DIRS = new Set(["node_modules", ".git", ".next", ".vercel", ".turbo", "coverage", "out", "build", "dist"]);
const CODE_EXT = new Set([".js", ".cjs", ".mjs", ".jsx", ".ts", ".cts", ".mts", ".tsx"]);
const CONFIG_FILE = /\.config\.[cm]?[jt]s$|^\.?(babelrc|eslintrc)(\.[cm]?js)?$/i;

// Worm fingerprints, in any code file.
const MARKERS = [
  { re: /global\s*\[\s*(['"])(!|_V|_H2?|_t_[su])\1\s*\]\s*=/, why: "assigns a worm marker on `global` (config-injection malware)" },
  { re: /global\s*\[\s*(['"])[rm]\1\s*\]\s*=\s*(require|module)\b/, why: "exposes require/module on `global` for a second-stage payload" },
  { re: /_\$_[0-9a-f]{4}\s*\(/, why: "obfuscator decoder call used by the worm" },
];
const OBFUSCATED_IDENT = /\b_0x[0-9a-f]{4,6}\b/g;

// Things a build config has no business doing.
const CONFIG_ONLY = [
  { re: /[^\s][ \t]{20,}[^\s]/, why: "code hidden after a run of spaces on the same line" },
  { re: /\bchild_process\b/, why: "spawns processes from a config file" },
  { re: /\beval\s*\(/, why: "calls eval from a config file" },
  { re: /\bnew\s+Function\s*\(|\bFunction\s*\(\s*['"`]/, why: "builds code at runtime (Function constructor)" },
  { re: /\bfromCharCode\b/, why: "decodes character codes from a config file" },
  { re: /\bcreateRequire\b/, why: "creates a CommonJS require inside an ESM config" },
];
const MAX_CONFIG_LINE = 300;

// Asset extensions and their real magic bytes. A "font" that starts with code is a dropper.
const ASSET_MAGIC = {
  ".woff2": [Buffer.from("wOF2")],
  ".woff": [Buffer.from("wOFF")],
  ".ttf": [Buffer.from([0, 1, 0, 0]), Buffer.from("true"), Buffer.from("OTTO")],
  ".otf": [Buffer.from("OTTO"), Buffer.from([0, 1, 0, 0])],
};
const BINARY_ASSET_EXT = new Set([".woff2", ".woff", ".ttf", ".otf", ".eot", ".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp", ".wasm"]);
const LOOKS_LIKE_CODE = /^\s*(global\s*\[|var\s|let\s|const\s|function\s|!function|\(function|\(async|require\s*\(|import\s|module\.exports)/;

// .gitignore must keep protecting secrets and bank statements (the worm deleted these lines).
const REQUIRED_IGNORES = [".env", ".env*.local", "*.pdf", "*.xlsx", "sample-data/", ".vscode"];

// package.json scripts that must keep running this guard first.
const GUARDED_SCRIPTS = ["dev", "build"];
const GUARD_CMD = "node scripts/security/preflight.mjs";
const INSTALL_HOOKS = ["preinstall", "install", "postinstall", "prepare"];

function* walk(dir, root) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walk(join(dir, entry.name), root);
    } else if (entry.isFile()) {
      yield join(dir, entry.name);
    }
  }
}

function head(path, n) {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(n);
    const read = readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

/** Returns every finding as { file, why }. Empty means the tree looks clean. */
export function scan(root) {
  const findings = [];
  const flag = (file, why) => findings.push({ file: relative(root, file) || basename(file), why });
  let checked = 0;

  for (const file of walk(root, root)) {
    checked++;
    const name = basename(file);
    const ext = extname(name).toLowerCase();

    if (/^temp_auto_push\.bat$/i.test(name)) flag(file, "worm propagation script (force-pushes infected commits)");
    else if (ext === ".bat" || ext === ".cmd") flag(file, "unexpected Windows script in the repo");

    if (BINARY_ASSET_EXT.has(ext)) {
      const bytes = head(file, 64);
      const magic = ASSET_MAGIC[ext];
      if (LOOKS_LIKE_CODE.test(bytes.toString("latin1"))) flag(file, `${ext} file that actually contains JavaScript (disguised dropper)`);
      else if (magic && bytes.length >= 4 && !magic.some((m) => bytes.subarray(0, m.length).equals(m))) {
        flag(file, `${ext} file without a valid ${ext.slice(1).toUpperCase()} header`);
      }
      continue;
    }

    if (name === "tasks.json" && basename(join(file, "..")) === ".vscode") {
      if (/folderOpen/.test(readFileSync(file, "utf8"))) flag(file, "VS Code task that runs automatically when the folder is opened");
      continue;
    }
    if (name === "settings.json" && basename(join(file, "..")) === ".vscode") {
      if (/"task\.allowAutomaticTasks"\s*:\s*(true|"on")/.test(readFileSync(file, "utf8"))) {
        flag(file, "enables automatic VS Code tasks");
      }
      continue;
    }

    if (!CODE_EXT.has(ext)) continue;
    const text = readFileSync(file, "utf8");
    for (const m of MARKERS) if (m.re.test(text)) flag(file, m.why);
    const idents = text.match(OBFUSCATED_IDENT);
    if (idents && idents.length >= 25) flag(file, `heavily obfuscated (${idents.length} _0x… identifiers)`);

    if (CONFIG_FILE.test(name)) {
      for (const m of CONFIG_ONLY) if (m.re.test(text)) flag(file, m.why);
      const longest = Math.max(0, ...text.split("\n").map((l) => l.length));
      if (longest > MAX_CONFIG_LINE) flag(file, `line of ${longest} characters in a config file`);
    }
  }

  const gitignore = join(root, ".gitignore");
  if (!existsSync(gitignore)) {
    flag(gitignore, ".gitignore is missing");
  } else {
    const lines = new Set(readFileSync(gitignore, "utf8").split(/\r?\n/).map((l) => l.trim()));
    for (const rule of REQUIRED_IGNORES) {
      if (!lines.has(rule)) flag(gitignore, `no longer ignores ${rule} (secrets / bank statements could be committed)`);
    }
  }

  const pkgPath = join(root, "package.json");
  if (existsSync(pkgPath)) {
    const scripts = JSON.parse(readFileSync(pkgPath, "utf8")).scripts ?? {};
    for (const s of GUARDED_SCRIPTS) {
      if (typeof scripts[s] === "string" && !scripts[s].startsWith(`${GUARD_CMD} &&`)) {
        flag(pkgPath, `"${s}" script no longer runs the security preflight first`);
      }
    }
    for (const hook of INSTALL_HOOKS) {
      if (scripts[hook]) flag(pkgPath, `install hook "${hook}" runs code on every install — review it`);
    }
  }

  return { findings, checked };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = resolve(fileURLToPath(import.meta.url), "../../..");
  const { findings, checked } = scan(root);
  if (findings.length === 0) {
    console.log(`✓ security preflight: ${checked} files checked, no worm footprints`);
  } else {
    console.error(`✗ security preflight FAILED — ${findings.length} finding(s). Not starting Next.js.\n`);
    for (const f of findings) console.error(`  ${f.file}: ${f.why}`);
    console.error("\nSee docs/security/2026-09-25-polinrider-incident.md. Do not open this folder in an editor with automatic tasks enabled.");
    process.exit(1);
  }
}
