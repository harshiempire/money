/**
 * Runs the model's SQL on a throwaway in-memory SQLite copy of one user's
 * data, in a separate Node process. Each safeguard is a fixed rule, not a
 * judgement:
 *
 * - The copy holds only the rows and columns in query-tables.ts. Neon, other
 *   users, logins and tokens are never in reach.
 * - The process gets no environment variables (no secrets) and runs with
 *   Node's permission model: no file access, no child processes.
 * - SQLite's authorizer allows reading our tables and the functions in
 *   QUERY_FUNCTIONS, nothing else: no writes, PRAGMA, ATTACH, schema reads or
 *   recursive queries. query_only is on as well.
 * - One statement per call; size limits on strings, SQL and memory; a cap on
 *   rows returned.
 * - A slow query is stopped by killing the process. SQLite can't be
 *   interrupted from JavaScript, so this is the only real time limit; the
 *   next query starts a fresh process.
 *
 * The authorizer needs Node 24.10+. Without it the process refuses to start.
 */
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { createInterface } from "node:readline";
import { QUERY_FUNCTIONS, type SandboxTable, type SqlValue } from "./query-tables";

export type QueryOutcome =
  | { ok: true; columns: string[]; rows: SqlValue[][]; truncated: boolean }
  | { ok: false; error: string };

export interface QuerySandbox {
  run(sql: string): Promise<QueryOutcome>;
  close(): void;
}

export interface SandboxOptions {
  queryTimeoutMs?: number;
  startTimeoutMs?: number;
  maxRows?: number;
  /** The Node binary. Bun (the test runner) has no SQLite authorizer, so tests run real Node. */
  nodePath?: string;
}

const MAX_SQL_CHARS = 4000;

/** The program the sandbox process runs. Plain CommonJS; it reads JSON lines on stdin. */
const SANDBOX_SOURCE = String.raw`
"use strict";
const { DatabaseSync, constants: C } = require("node:sqlite");
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const message = (e) => String((e && e.message) || e);
let db = null;
let cfg = null;

function init(msg) {
  if (typeof DatabaseSync.prototype.setAuthorizer !== "function") {
    throw new Error("this Node has no SQLite authorizer (needs 24.10 or later)");
  }
  cfg = msg;
  db = new DatabaseSync(":memory:", { limits: msg.limits });
  for (const t of msg.tables) {
    db.exec("CREATE TABLE " + t.name + " (" + t.columns.map((c) => c.name + " " + c.type).join(", ") + ")");
    const insert = db.prepare("INSERT INTO " + t.name + " VALUES (" + t.columns.map(() => "?").join(", ") + ")");
    db.exec("BEGIN");
    for (const row of t.rows) insert.run(...row);
    db.exec("COMMIT");
  }
  db.exec("PRAGMA hard_heap_limit = " + Number(msg.heapLimitBytes));
  db.exec("PRAGMA query_only = ON");
  const tables = new Set(msg.tables.map((t) => t.name));
  const functions = new Set(msg.functions);
  db.setAuthorizer((action, arg1, arg2) => {
    if (action === C.SQLITE_SELECT) return C.SQLITE_OK;
    if (action === C.SQLITE_READ) return tables.has(arg1) ? C.SQLITE_OK : C.SQLITE_DENY;
    if (action === C.SQLITE_FUNCTION) return functions.has(String(arg2).toLowerCase()) ? C.SQLITE_OK : C.SQLITE_DENY;
    return C.SQLITE_DENY;
  });
}

function cell(v) {
  if (typeof v === "bigint") return Number(v);
  if (v instanceof Uint8Array) return "(binary)";
  if (typeof v === "string" && v.length > cfg.maxCell) return v.slice(0, cfg.maxCell) + "…";
  return v;
}

function query(sql) {
  const stmt = db.prepare(sql);
  const strip = (s) => s.trim().replace(/;+\s*$/, "").trim();
  if (strip(stmt.sourceSQL) !== strip(sql)) return { ok: false, error: "Send one SELECT statement at a time." };
  stmt.setReturnArrays(true);
  const columns = stmt.columns().map((c) => c.name);
  const rows = [];
  let truncated = false;
  for (const row of stmt.iterate()) {
    if (rows.length === cfg.maxRows) { truncated = true; break; }
    rows.push(row.map(cell));
  }
  return { ok: true, columns, rows, truncated };
}

let buffered = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffered += chunk;
  let nl;
  while ((nl = buffered.indexOf("\n")) >= 0) {
    const line = buffered.slice(0, nl);
    buffered = buffered.slice(nl + 1);
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.type === "init") {
      try { init(msg); send({ type: "ready" }); } catch (e) { send({ type: "fatal", error: message(e) }); }
    } else if (msg.type === "query") {
      let out;
      try { out = query(msg.sql); } catch (e) { out = { ok: false, error: message(e) }; }
      send({ type: "result", id: msg.id, ...out });
    }
  }
});
`;

/** How the process is started: no secrets in its environment, no file or process access. */
export function sandboxSpawnArgs(nodePath: string) {
  return {
    command: nodePath,
    args: ["--permission", "--max-old-space-size=96", "--no-warnings", "-e", SANDBOX_SOURCE],
    // Empty on purpose: no DATABASE_URL, AUTH_SECRET or token key in the sandbox.
    options: { env: {} as NodeJS.ProcessEnv, stdio: "pipe" } satisfies SpawnOptionsWithoutStdio,
  };
}

/** An absolute path: the process gets no PATH to look a bare "node" up in. */
const defaultNodePath = () => {
  const bun = (globalThis as { Bun?: { which(cmd: string): string | null } }).Bun;
  return bun ? (bun.which("node") ?? "node") : process.execPath;
};

type Pending = { resolve: (o: QueryOutcome) => void; timer: ReturnType<typeof setTimeout> };

/**
 * A sandbox for one turn. Nothing starts until the first query; `load` is
 * called once and its tables are reused if the process has to be restarted.
 */
export function createQuerySandbox(load: () => Promise<SandboxTable[]>, opts: SandboxOptions = {}): QuerySandbox {
  const queryTimeoutMs = opts.queryTimeoutMs ?? 3000;
  const startTimeoutMs = opts.startTimeoutMs ?? 5000;
  const maxRows = opts.maxRows ?? 100;
  const nodePath = opts.nodePath ?? defaultNodePath();

  let tables: Promise<SandboxTable[]> | null = null;
  let proc: ChildProcessWithoutNullStreams | null = null;
  let ready: Promise<string | null> | null = null;
  /** Set when the engine refuses to start (e.g. no authorizer): don't keep retrying. */
  let fatal: string | null = null;
  let closed = false;
  let nextId = 1;
  const pending = new Map<number, Pending>();

  const failAll = (error: string) => {
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      pending.delete(id);
      p.resolve({ ok: false, error });
    }
  };

  const kill = () => {
    if (proc) {
      proc.kill("SIGKILL");
      proc = null;
    }
    ready = null;
  };

  /** Starts the process if needed. Resolves to an error message, or null when ready. */
  const start = (): Promise<string | null> => {
    if (fatal) return Promise.resolve(fatal);
    if (ready) return ready;
    const attempt = (async (): Promise<string | null> => {
      let data: SandboxTable[];
      try {
        data = await (tables ??= load());
      } catch {
        tables = null;
        return "Couldn't load your data for the query.";
      }
      if (closed) return "The query was cancelled.";
      const { command, args, options } = sandboxSpawnArgs(nodePath);
      const child = spawn(command, args, options);
      proc = child;
      return new Promise<string | null>((resolve) => {
        const timer = setTimeout(() => {
          kill();
          resolve("The query engine didn't start in time.");
        }, startTimeoutMs);
        const settle = (error: string | null) => {
          clearTimeout(timer);
          resolve(error);
        };
        // Only the current process's death fails waiting queries; one we
        // killed for being slow has already answered its query.
        child.on("error", () => {
          settle("The query engine couldn't start.");
          if (proc === child) {
            kill();
            failAll("The query engine stopped.");
          }
        });
        child.on("exit", () => {
          settle("The query engine stopped while starting.");
          if (proc === child) {
            proc = null;
            ready = null;
            failAll("The query stopped unexpectedly. It may have used too much memory; make it simpler.");
          }
        });
        child.stdin.on("error", () => {});
        child.stderr.resume();
        createInterface({ input: child.stdout }).on("line", (line) => {
          let msg: { type?: string; id?: number; error?: string } & Partial<QueryOutcome>;
          try {
            msg = JSON.parse(line);
          } catch {
            return;
          }
          if (msg.type === "ready") settle(null);
          else if (msg.type === "fatal") {
            fatal = `The query engine refused to start: ${msg.error}`;
            kill();
            settle(fatal);
          } else if (msg.type === "result" && typeof msg.id === "number") {
            const p = pending.get(msg.id);
            if (!p) return;
            clearTimeout(p.timer);
            pending.delete(msg.id);
            const { type: _t, id: _i, ...outcome } = msg;
            p.resolve(outcome as QueryOutcome);
          }
        });
        child.stdin.write(
          JSON.stringify({
            type: "init",
            tables: data,
            functions: QUERY_FUNCTIONS,
            maxRows,
            maxCell: 200,
            heapLimitBytes: 64 * 1024 * 1024,
            limits: { length: 100_000, sqlLength: MAX_SQL_CHARS, exprDepth: 100, compoundSelect: 20, attach: 0, likePatternLength: 200 },
          }) + "\n",
        );
      });
    })();
    ready = attempt;
    // A failed start can be retried by the next query (unless it was fatal).
    void attempt.then((error) => {
      if (error && ready === attempt) ready = null;
    });
    return attempt;
  };

  return {
    async run(sql) {
      const text = String(sql ?? "").trim();
      if (!text) return { ok: false, error: "The SQL is empty." };
      if (text.length > MAX_SQL_CHARS) return { ok: false, error: `Keep the SQL under ${MAX_SQL_CHARS} characters.` };
      if (!/^(select|with)\b/i.test(text)) return { ok: false, error: "Only SELECT queries can run." };
      if (closed) return { ok: false, error: "The query was cancelled." };

      const startError = await start();
      if (startError) return { ok: false, error: startError };
      const child = proc;
      if (!child) return { ok: false, error: "The query engine stopped." };

      const id = nextId++;
      return new Promise<QueryOutcome>((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          // SQLite can't be interrupted from JavaScript: stop the whole process.
          if (proc === child) kill();
          resolve({
            ok: false,
            error: `The query took longer than ${queryTimeoutMs / 1000}s and was stopped. Make it simpler, e.g. join on txn_ref instead of pairing every row with every row.`,
          });
        }, queryTimeoutMs);
        pending.set(id, { resolve, timer });
        child.stdin.write(JSON.stringify({ type: "query", id, sql: text }) + "\n");
      });
    },
    close() {
      closed = true;
      failAll("The query was cancelled.");
      kill();
    },
  };
}
