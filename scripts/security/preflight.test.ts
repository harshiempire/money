import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
// @ts-expect-error — plain ESM script without type declarations
import { scan } from "./preflight.mjs";

// Built from pieces so this file never contains the literal campaign markers.
const G = (key: string) => "glob" + "al[" + `'${key}'` + "]";

const CLEAN_GITIGNORE = [".env", ".env*.local", "*.pdf", "*.xlsx", "sample-data/", ".vscode", ""].join("\n");
const CLEAN_PKG = JSON.stringify({
  scripts: {
    dev: "node scripts/security/preflight.mjs && next dev",
    build: "node scripts/security/preflight.mjs && next build",
  },
});

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function repo(files: Record<string, string | Buffer>) {
  const root = mkdtempSync(join(tmpdir(), "preflight-"));
  dirs.push(root);
  const all = { ".gitignore": CLEAN_GITIGNORE, "package.json": CLEAN_PKG, ...files };
  for (const [path, content] of Object.entries(all)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return scan(root).findings.map((f: { file: string; why: string }) => `${f.file}: ${f.why}`);
}

describe("security preflight", () => {
  test("a clean tree passes", () => {
    expect(
      repo({
        "postcss.config.mjs": 'export default {\n  plugins: { "@tailwindcss/postcss": {} },\n};\n',
        "src/app/page.tsx": "export default function Page() { return null; }\n",
        "public/fonts/ok.woff2": Buffer.concat([Buffer.from("wOF2"), Buffer.alloc(60)]),
      }),
    ).toEqual([]);
  });

  test("catches a payload hidden after spaces in postcss.config.mjs (the 2026-09-25 injection)", () => {
    const poisoned = `export default {\n  plugins: {},\n};${" ".repeat(149)}${G("!")}='9-7721';var _0x2d013d=1;\n`;
    const findings = repo({ "postcss.config.mjs": poisoned });
    expect(findings.some((f) => f.includes("worm marker"))).toBe(true);
    expect(findings.some((f) => f.includes("hidden after a run of spaces"))).toBe(true);
  });

  test("catches a JavaScript dropper disguised as a font", () => {
    const findings = repo({ "src/app/api/public/fonts/fa-solid-900.woff2": `${G("!")}='9-7721';var x=1;` });
    expect(findings).toEqual(["src/app/api/public/fonts/fa-solid-900.woff2: .woff2 file that actually contains JavaScript (disguised dropper)"]);
  });

  test("catches a font with a wrong header", () => {
    expect(repo({ "public/x.woff2": Buffer.from("NOPE" + "x".repeat(20)) })).toEqual([
      "public/x.woff2: .woff2 file without a valid WOFF2 header",
    ]);
  });

  test("catches auto-run VS Code tasks and the propagation script", () => {
    const findings = repo({
      ".vscode/tasks.json": JSON.stringify({ tasks: [{ runOptions: { runOn: "folderOpen" } }] }),
      ".vscode/settings.json": JSON.stringify({ "task.allowAutomaticTasks": true }),
      "temp_auto_push.bat": "git push -uf origin",
    });
    expect(findings).toContain(".vscode/tasks.json: VS Code task that runs automatically when the folder is opened");
    expect(findings).toContain(".vscode/settings.json: enables automatic VS Code tasks");
    expect(findings).toContain("temp_auto_push.bat: worm propagation script (force-pushes infected commits)");
  });

  test("catches a .gitignore that stops protecting secrets and statements", () => {
    const findings = repo({ ".gitignore": "node_modules\n.env*.local\n" });
    expect(findings).toContain(".gitignore: no longer ignores .env (secrets / bank statements could be committed)");
    expect(findings).toContain(".gitignore: no longer ignores *.pdf (secrets / bank statements could be committed)");
  });

  test("catches the guard being removed from build/dev, and install hooks", () => {
    const findings = repo({
      "package.json": JSON.stringify({ scripts: { dev: "next dev", build: "next build", postinstall: "node x.js" } }),
    });
    expect(findings).toContain('package.json: "build" script no longer runs the security preflight first');
    expect(findings).toContain('package.json: "dev" script no longer runs the security preflight first');
    expect(findings).toContain('package.json: install hook "postinstall" runs code on every install — review it');
  });

  test("flags dangerous APIs in config files but not in app code", () => {
    const src = 'import { spawn } from "child_process";\nexport default {};\n';
    expect(repo({ "next.config.mjs": src })).toContain("next.config.mjs: spawns processes from a config file");
    expect(repo({ "src/lib/run.ts": src })).toEqual([]);
  });

  test("the real repo is clean", () => {
    const root = resolve(import.meta.dir, "../..");
    expect(scan(root).findings).toEqual([]);
  });
});
