#!/usr/bin/env node
/**
 * Isolated launcher and browser harness for the Money Next.js app.
 * State lives under /tmp/money-verify/<runId>. Proof files written with a
 * relative path land in /tmp/money-verify-evidence/<runId> and survive cleanup.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import postgres from "postgres";

const require = createRequire(import.meta.url);
const embeddedPostgresModule = require("embedded-postgres");
const EmbeddedPostgres =
  typeof embeddedPostgresModule === "function"
    ? embeddedPostgresModule
    : embeddedPostgresModule.default;

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../../../..");
const ROOT_STATE = "/tmp/money-verify";
const EVIDENCE_ROOT = "/tmp/money-verify-evidence";

function fail(message) {
  console.error(message);
  process.exit(1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next == null || next.startsWith("--")) flags[key] = true;
      else {
        flags[key] = next;
        i++;
      }
    } else positional.push(arg);
  }
  return { positional, flags };
}

function runDir(runId) {
  return path.join(ROOT_STATE, runId);
}

function statePath(runId) {
  return path.join(runDir(runId), "state.json");
}

function evidenceDir(runId) {
  return path.join(EVIDENCE_ROOT, runId);
}

function readLatest() {
  const file = path.join(ROOT_STATE, "latest");
  if (!existsSync(file)) return null;
  const id = readFileSync(file, "utf8").trim();
  return id || null;
}

function writeLatest(runId) {
  mkdirSync(ROOT_STATE, { recursive: true });
  writeFileSync(path.join(ROOT_STATE, "latest"), runId);
}

function readState(runId) {
  const file = statePath(runId);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8"));
}

function writeState(state) {
  mkdirSync(runDir(state.runId), { recursive: true });
  writeFileSync(statePath(state.runId), JSON.stringify(state, null, 2));
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function resolveRunId(command) {
  if (process.env.MONEY_VERIFY_RUN) return process.env.MONEY_VERIFY_RUN;
  if (command === "launch") {
    const latest = readLatest();
    if (latest) {
      const state = readState(latest);
      if (state && pidAlive(state.nextPid)) {
        fail(
          `Money verification instance ${latest} is already running at ${state.baseUrl}. Run cleanup, or set MONEY_VERIFY_RUN to a new id for a second instance.`,
        );
      }
    }
    const id = `run-${Date.now()}`;
    writeLatest(id);
    return id;
  }
  const latest = readLatest();
  if (!latest) fail("No verification instance. Run launch first, or set MONEY_VERIFY_RUN.");
  return latest;
}

function freePort(start) {
  return new Promise((resolve, reject) => {
    const tryPort = (port) => {
      if (port > start + 50) {
        reject(new Error(`no free port from ${start}`));
        return;
      }
      const server = net.createServer();
      server.once("error", () => tryPort(port + 1));
      server.listen(port, "127.0.0.1", () => {
        server.close(() => resolve(port));
      });
    };
    tryPort(start);
  });
}

async function postgresDaemon() {
  const runId = process.env.MONEY_VERIFY_RUN;
  if (!runId) fail("postgres-daemon requires MONEY_VERIFY_RUN");
  const state = readState(runId);
  if (!state) fail(`No state for ${runId}`);
  const cluster = postgresCluster(state);
  await cluster.initialise();
  await cluster.start();
  await cluster.createDatabase("money");
  writeFileSync(path.join(runDir(runId), "postgres.ready"), "ok");
  await new Promise(() => {});
}

function postgresCluster(state) {
  return new EmbeddedPostgres({
    databaseDir: state.databaseDir,
    user: "postgres",
    password: "password",
    port: state.dbPort,
    persistent: true,
  });
}

function loginShellReady(body) {
  return body.includes("<title>Money</title>") && (body.includes("Loading") || body.includes("Sign in"));
}

async function waitForSignInHeading(baseUrl) {
  const browser = await chromium.launch({
    channel: "chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "Sign in", exact: true }).waitFor({
      state: "visible",
      timeout: 30000,
    });
  } finally {
    await browser.close();
  }
}

async function waitForLogin(baseUrl, logFile, timeoutMs) {
  const started = Date.now();
  let lastError = "no response";
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/login`);
      const body = await response.text();
      if (response.status === 200 && loginShellReady(body)) {
        await waitForSignInHeading(baseUrl);
        return;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(1000);
  }
  const tail = existsSync(logFile)
    ? readFileSync(logFile, "utf8").split("\n").slice(-40).join("\n")
    : "";
  fail(`Money did not become usable at ${baseUrl}/login (${lastError}).\n${tail}`);
}

function spawnLogged(command, args, env, logFile) {
  const logFd = openSync(logFile, "a");
  const child = spawn(command, args, {
    cwd: REPO_ROOT,
    env,
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  return child.pid;
}

async function launch() {
  const runId = resolveRunId("launch");
  const dir = runDir(runId);
  mkdirSync(dir, { recursive: true });
  mkdirSync(evidenceDir(runId), { recursive: true });

  const httpPort = await freePort(4173);
  const dbPort = await freePort(55432);
  const databaseDir = path.join(dir, "pg");
  const baseUrl = `http://127.0.0.1:${httpPort}`;
  const databaseUrl = `postgresql://postgres:password@127.0.0.1:${dbPort}/money`;
  const state = {
    runId,
    baseUrl,
    port: httpPort,
    dbPort,
    databaseDir,
    databaseUrl,
    nextPid: null,
    evidenceDir: evidenceDir(runId),
    repoRoot: REPO_ROOT,
    startedAt: new Date().toISOString(),
  };
  writeState(state);

  process.stderr.write(`verify-money: initialising Postgres on 127.0.0.1:${dbPort}\n`);
  state.postgresPid = spawnLogged(
    process.execPath,
    [fileURLToPath(import.meta.url), "postgres-daemon"],
    { ...process.env, MONEY_VERIFY_RUN: runId },
    path.join(dir, "postgres.log"),
  );
  writeState(state);
  const readyFile = path.join(dir, "postgres.ready");
  const postgresStarted = Date.now();
  while (!existsSync(readyFile)) {
    if (!pidAlive(state.postgresPid)) {
      const log = existsSync(path.join(dir, "postgres.log"))
        ? readFileSync(path.join(dir, "postgres.log"), "utf8").split("\n").slice(-30).join("\n")
        : "";
      fail(`Postgres daemon exited.\n${log}`);
    }
    if (Date.now() - postgresStarted > 60000) fail("Postgres daemon did not become ready");
    await sleep(200);
  }

  const migrate = spawn("pnpm", ["exec", "drizzle-kit", "migrate"], {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "inherit",
  });
  const migrateCode = await new Promise((resolve) => migrate.on("close", resolve));
  if (migrateCode !== 0) {
    killGroup(state.postgresPid);
    fail(`drizzle-kit migrate exited ${migrateCode}`);
  }

  const authSecret = randomBytes(32).toString("base64");
  const logFile = path.join(dir, "next.log");
  const env = { ...process.env, DATABASE_URL: databaseUrl, AUTH_SECRET: authSecret, AUTH_URL: baseUrl };
  delete env.UPSTASH_REDIS_REST_URL;
  delete env.UPSTASH_REDIS_REST_TOKEN;
  env.SKIP_AUTH_BOOTSTRAP_CHECK = "1";

  const preflight = spawn("node", ["scripts/security/preflight.mjs"], {
    cwd: REPO_ROOT,
    env,
    stdio: "inherit",
  });
  const preflightCode = await new Promise((resolve) => preflight.on("close", resolve));
  if (preflightCode !== 0) {
    killGroup(state.postgresPid);
    fail(`security preflight exited ${preflightCode}`);
  }

  process.stderr.write(`verify-money: starting next dev at ${baseUrl}\n`);
  state.nextPid = spawnLogged(
    "pnpm",
    ["exec", "next", "dev", "-H", "127.0.0.1", "-p", String(httpPort)],
    env,
    logFile,
  );
  writeState(state);
  await waitForLogin(baseUrl, logFile, 180000);
  console.log(
    JSON.stringify(
      {
        ok: true,
        runId,
        baseUrl,
        databaseDir,
        evidenceDir: state.evidenceDir,
      },
      null,
      2,
    ),
  );
}

async function doctor() {
  const runId = resolveRunId("doctor");
  const state = readState(runId);
  if (!state) fail(`No state for ${runId}. Run launch first.`);
  const problems = [];
  if (!pidAlive(state.nextPid)) problems.push(`next pid ${state.nextPid} is not running`);
  if (!pidAlive(state.postgresPid)) problems.push(`postgres pid ${state.postgresPid} is not running`);

  let login = null;
  try {
    const response = await fetch(`${state.baseUrl}/login`);
    const body = await response.text();
    login = {
      status: response.status,
      shell: loginShellReady(body),
    };
    if (response.status !== 200 || !login.shell) {
      problems.push(`/login is not the Money sign-in shell (HTTP ${response.status})`);
    }
  } catch (error) {
    problems.push(`GET ${state.baseUrl}/login failed: ${error instanceof Error ? error.message : error}`);
  }

  let db = null;
  try {
    const sql = postgres(state.databaseUrl, { max: 1, connect_timeout: 5 });
    const rows = await sql`select 1 as ok`;
    await sql.end();
    db = rows[0]?.ok === 1;
    if (!db) problems.push("database did not return select 1");
  } catch (error) {
    problems.push(`database: ${error instanceof Error ? error.message : error}`);
  }

  let nextVersion = null;
  try {
    nextVersion = JSON.parse(
      readFileSync(path.join(REPO_ROOT, "node_modules/next/package.json"), "utf8"),
    ).version;
  } catch {
    problems.push("installed next package was not readable");
  }

  const report = {
    ok: problems.length === 0,
    runId,
    baseUrl: state.baseUrl,
    databaseDir: state.databaseDir,
    evidenceDir: state.evidenceDir,
    nextPid: state.nextPid,
    nextVersion,
    login,
    db,
    problems,
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exit(1);
}

function killGroup(pid) {
  if (!pid || !pidAlive(pid)) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
}

async function cleanup() {
  const runId = resolveRunId("cleanup");
  const state = readState(runId);
  if (!state) {
    console.log(JSON.stringify({ ok: true, runId, alreadyClean: true }));
    return;
  }
  killGroup(state.browserPid);
  await sleep(300);
  killGroup(state.nextPid);
  killGroup(state.postgresPid);
  await sleep(500);
  if (pidAlive(state.nextPid)) {
    try {
      process.kill(-state.nextPid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  try {
    const cluster = postgresCluster(state);
    await cluster.stop();
  } catch (error) {
    process.stderr.write(
      `verify-money: postgres stop: ${error instanceof Error ? error.message : error}\n`,
    );
  }
  rmSync(runDir(runId), { recursive: true, force: true });
  const latest = readLatest();
  if (latest === runId) rmSync(path.join(ROOT_STATE, "latest"), { force: true });
  console.log(
    JSON.stringify({
      ok: true,
      runId,
      evidenceDir: state.evidenceDir,
      evidenceKept: existsSync(state.evidenceDir),
    }),
  );
}

async function dbQuery(sqlText) {
  const trimmed = sqlText.trim();
  if (!/^select\b/i.test(trimmed)) fail("db query only runs a single SELECT");
  if (trimmed.includes(";")) fail("db query accepts one statement and no semicolon");
  const runId = resolveRunId("db");
  const state = readState(runId);
  if (!state) fail(`No state for ${runId}. Run launch first.`);
  const sql = postgres(state.databaseUrl, { max: 1, connect_timeout: 5 });
  try {
    const rows = await sql.unsafe(trimmed);
    console.log(JSON.stringify(rows, null, 2));
  } finally {
    await sql.end();
  }
}

function socketPath(runId) {
  return path.join(runDir(runId), "browser.sock");
}

function requestDaemon(sock, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(sock);
    const chunks = [];
    socket.on("error", reject);
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString() || "{}"));
      } catch (error) {
        reject(error);
      }
    });
    socket.end(JSON.stringify(payload));
  });
}

async function ensureBrowser(state) {
  const sock = socketPath(state.runId);
  if (state.browserPid && pidAlive(state.browserPid) && existsSync(sock)) return sock;
  if (existsSync(sock)) rmSync(sock, { force: true });
  const logFd = openSync(path.join(runDir(state.runId), "browser.log"), "a");
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "browser-daemon"], {
    cwd: REPO_ROOT,
    env: { ...process.env, MONEY_VERIFY_RUN: state.runId },
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  state.browserPid = child.pid;
  writeState(state);
  const started = Date.now();
  while (Date.now() - started < 30000) {
    if (existsSync(sock)) return sock;
    if (!pidAlive(child.pid)) {
      const log = readFileSync(path.join(runDir(state.runId), "browser.log"), "utf8");
      fail(`browser daemon exited.\n${log.split("\n").slice(-30).join("\n")}`);
    }
    await sleep(200);
  }
  fail("browser daemon did not open a socket");
}

function roleLocator(page, flags) {
  const role = flags.role;
  const name = flags.name;
  if (!role || !name) throw new Error("browser actions need --role and --name");
  return page.getByRole(role, { name, exact: true }).filter({ visible: true });
}

async function requireOne(locator, flags) {
  const count = await locator.count();
  if (count !== 1) {
    throw new Error(`expected 1 visible ${flags.role} named "${flags.name}", found ${count}`);
  }
  return locator;
}

function evidencePath(state, file) {
  if (!file) throw new Error("missing --path");
  const resolved = path.isAbsolute(file) ? file : path.join(state.evidenceDir, file);
  mkdirSync(path.dirname(resolved), { recursive: true });
  return resolved;
}

async function runBrowserAction(page, state, action, positional, flags) {
  if (action === "open") {
    const target = positional[0];
    if (!target) throw new Error("browser open needs a path");
    const url = target.startsWith("http")
      ? target
      : `${state.baseUrl}${target.startsWith("/") ? "" : "/"}${target}`;
    await page.goto(url, { waitUntil: "domcontentloaded" });
  } else if (action === "click") {
    const locator = await requireOne(roleLocator(page, flags), flags);
    await locator.click();
  } else if (action === "fill") {
    if (flags.value == null) throw new Error("browser fill needs --value");
    const locator = await requireOne(roleLocator(page, flags), flags);
    await locator.fill(String(flags.value));
  } else if (action === "snapshot") {
    const aria = await page.locator("body").ariaSnapshot();
    const file = evidencePath(state, flags.path);
    writeFileSync(file, aria);
    return file;
  } else if (action === "screenshot") {
    const file = evidencePath(state, flags.path);
    await page.screenshot({ path: file, fullPage: true });
    return file;
  } else {
    throw new Error(`unknown browser action ${action}`);
  }
  if (flags.expect) {
    await page.getByText(String(flags.expect), { exact: false }).first().waitFor({
      state: "visible",
      timeout: 30000,
    });
  }
  return page.url();
}

async function browserDaemon() {
  const runId = process.env.MONEY_VERIFY_RUN;
  if (!runId) fail("browser-daemon requires MONEY_VERIFY_RUN");
  const state = readState(runId);
  if (!state) fail(`No state for ${runId}`);
  const profile = path.join(runDir(runId), "chrome-profile");
  mkdirSync(profile, { recursive: true });
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chrome",
    headless: true,
    viewport: { width: 1280, height: 800 },
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = context.pages()[0] ?? (await context.newPage());
  const sock = socketPath(runId);
  if (existsSync(sock)) rmSync(sock, { force: true });
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    const chunks = [];
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("end", () => {
      const job = (async () => {
        const cmd = JSON.parse(Buffer.concat(chunks).toString() || "{}");
        const fresh = readState(runId) ?? state;
        const output = await runBrowserAction(page, fresh, cmd.action, cmd.positional ?? [], cmd.flags ?? {});
        socket.end(JSON.stringify({ ok: true, output }));
      })().catch((error) => {
        socket.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      });
      return job;
    });
  });
  await new Promise((resolve) => server.listen(sock, resolve));
  await new Promise(() => {});
}

async function browser(positional, flags) {
  const action = positional[0];
  if (!action) fail("browser needs an action: open, click, fill, snapshot, screenshot");
  const runId = resolveRunId("browser");
  const state = readState(runId);
  if (!state) fail(`No state for ${runId}. Run launch first.`);
  const sock = await ensureBrowser(state);
  const response = await requestDaemon(sock, {
    action,
    positional: positional.slice(1),
    flags,
  });
  if (!response.ok) fail(response.error || "browser action failed");
  if (response.output) console.log(response.output);
}

const { positional, flags } = parseArgs(process.argv.slice(2));
const command = positional[0];

if (command === "browser-daemon") {
  await browserDaemon();
} else if (command === "postgres-daemon") {
  await postgresDaemon();
} else if (command === "launch") {
  await launch();
  process.exit(0);
} else if (command === "doctor") {
  await doctor();
  process.exit(0);
} else if (command === "cleanup") {
  await cleanup();
  process.exit(0);
} else if (command === "db" && positional[1] === "query") {
  const sqlText = positional.slice(2).join(" ");
  if (!sqlText) fail("db query needs a SELECT");
  await dbQuery(sqlText);
  process.exit(0);
} else if (command === "browser") {
  await browser(positional.slice(1), flags);
  process.exit(0);
} else {
  fail(
    "usage: verify-money launch | doctor | cleanup | db query <select> | browser open|click|fill|snapshot|screenshot",
  );
}
