/** Dependency-free CI audit. Never imports application modules or connects to a DB. */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAPABILITIES, AREA_PATHS, NON_FINANCIAL_ACTIONS, NON_FINANCIAL_TOOLS, LEGACY_PROMISE_CORES } from '../src/lib/ledger/capabilities.ts';

process.chdir(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const problems = [];
const read = file => readFileSync(file, 'utf8');
const files = dir => readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter(f => /\.tsx?$/.test(f)).map(f => `${dir}/${f}`);
// Same directive-prologue walk as server-action-exports.ts. Strip comments first;
// a mention in documentation must never turn a regular module into a server door.
function isUseServer(source) {
  const text = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
  let rest = text.trimStart();
  while (/^["']/.test(rest)) {
    const m = /^(["'])([^"']*)\1\s*;?/.exec(rest);
    if (!m) return false;
    if (m[2] === 'use server') return true;
    rest = rest.slice(m[0].length).trimStart();
  }
  return false;
}
// Node's own TS stripper erases type-only exports, just as Bun.Transpiler.scan
// does in check-actions. Handle declarations, aliases, defaults and re-exports.
// Export stars cannot be inventoried locally: fail closed rather than miss doors.
function exportsOf(source, path) {
  let js;
  try { js = stripTypeScriptTypes(source); }
  catch (e) { problems.push(`${path}: cannot scan TypeScript: ${e.message}`); return []; }
  js = js.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
  const names = [...js.matchAll(/\bexport\s+(?:async\s+)?(?:const|let|var|function|class)\s+(\w+)/g)].map(m => m[1]);
  for (const m of js.matchAll(/\bexport\s*\{([^}]+)\}/g)) {
    for (const part of m[1].split(',')) {
      const tokens = part.trim().split(/\s+as\s+/);
      if (tokens[0]) names.push(tokens.at(-1).trim());
    }
  }
  if (/\bexport\s+default\b/.test(js)) names.push('default');
  if (/\bexport\s*\*/.test(js)) problems.push(`${path}: export-star requires explicit named exports for the capability audit`);
  return [...new Set(names)];
}
const appFiles = files('src/app');
const actions = appFiles.filter(p => isUseServer(read(p))).flatMap(p => exportsOf(read(p), p).map(name => ({name, file:p})));
const server = read('src/lib/mcp/server.ts');
const tools = [...server.matchAll(/\bserver\.registerTool\(\s*["']([^"']+)["']/g)].map(m => {
  const prefix = server.slice(0, m.index);
  const scope = prefix.includes('if (scopeAllows(principal.scope, "write"))') ? 'write' : prefix.includes('if (scopeAllows(principal.scope, "propose"))') ? 'propose' : 'read';
  return {name:m[1], scope};
});
// The only dynamic registration is the RelationalInputs loop. Refuse new dynamic
// registration shapes so they cannot silently escape the inventory.
const calls = [...server.matchAll(/\bserver\.registerTool\(\s*([^\s"'][^,]*)[,]/g)];
for (const m of calls) if (m[1].trim() !== 'name' || !server.slice(Math.max(0,m.index-100),m.index).includes('Object.keys(RelationalInputs)')) problems.push('server.ts: unknown dynamic tool registration');
const relational = read('src/lib/mcp/relational-schemas.ts').split('export const RelationalInputs = {')[1]?.split('\n};')[0];
if (!relational) problems.push('Cannot inventory RelationalInputs');
else for (const m of relational.matchAll(/^  (\w+): Schema\.Struct/gm)) tools.push({name:m[1],scope:'write'});
function inventory(label, actual, registered, exclusions) {
  const all = [...registered, ...Object.keys(exclusions)];
  for (const name of new Set([...actual, ...all])) {
    const count = all.filter(n => n === name).length;
    if (!actual.includes(name)) problems.push(`${label} ${name}: registered but does not exist`);
    else if (count !== 1) problems.push(`${label} ${name}: expected exactly one registration, found ${count}`);
  }
  for (const [name,reason] of Object.entries(exclusions)) if (!reason.trim()) problems.push(`${label} ${name}: empty exclusion reason`);
}
inventory('action', actions.map(a=>a.name), CAPABILITIES.flatMap(c=>'actions' in c.app?c.app.actions:[]), NON_FINANCIAL_ACTIONS);
inventory('tool', tools.map(t=>t.name), CAPABILITIES.flatMap(c=>'tools' in c.mcp?c.mcp.tools.map(t=>t.name):[]), NON_FINANCIAL_TOOLS);
const handlers = appFiles.filter(p=>p.endsWith('-handlers.ts'));
const adapters = ['src/lib/mcp/write-ops.ts','src/lib/mcp/relational-write-ops.ts'];
const ids = new Set();
const references = new Map();
for (const c of CAPABILITIES) {
  if (ids.has(c.id)) problems.push(`Duplicate capability id: ${c.id}`);
  ids.add(c.id);
  if (c.impl === 'promise' && !LEGACY_PROMISE_CORES.includes(c.id)) problems.push(`${c.id}: new promise core; use Effect`);
  for (const [door, value] of [['app',c.app],['mcp',c.mcp]]) if ('none' in value && !value.none.trim()) problems.push(`${c.id}: ${door}.none needs a reason`);
  for (const area of c.refresh) if (!AREA_PATHS[area]?.length) problems.push(`${c.id}: unknown or empty refresh area ${area}`);
  for (const ref of [c.core,c.read,...c.moneyRules].filter(Boolean)) {
    if (!existsSync(ref.module)) { problems.push(`${c.id}: missing module ${ref.module}`); continue; }
    if (!references.has(ref.module)) references.set(ref.module,exportsOf(read(ref.module),ref.module));
    if (!references.get(ref.module).includes(ref.export)) problems.push(`${c.id}: ${ref.module} does not export ${ref.export}`);
  }
  if (!c.core && !c.read) problems.push(`${c.id}: null core requires a read reference documenting the implementation`);
  if (c.kind === 'write' && c.core) for (const [door,paths] of [['app',handlers],['mcp',adapters]]) {
    if ('none' in c[door]) continue;
    if (!paths.some(p => new RegExp(`\\b${c.core.export}\\b`).test(read(p)))) problems.push(`${c.id}: ${door} does not reference core ${c.core.export}`);
  }
  if ('tools' in c.mcp) for (const t of c.mcp.tools) {
    const actual = tools.find(a=>a.name===t.name);
    if (actual && actual.scope!==t.scope) problems.push(`${c.id}: ${t.name} scope ${t.scope}, server requires ${actual.scope}`);
  }
}
for (const area of ['transactions','reimbursements','people','dashboard','spend','connections','import','assistant']) if (!AREA_PATHS[area]?.length) problems.push(`Missing AREA_PATHS.${area}`);
for (const id of LEGACY_PROMISE_CORES) if (!CAPABILITIES.some(c=>c.id===id && c.impl==='promise')) problems.push(`${id}: stale legacy promise entry`);
// Every public operation in a write module must be represented, even if neither
// door exposes it yet. New ledger modules are reviewed explicitly, not ignored.
const infrastructure = new Set(['context','store','relational-store','rules','services','run','owed-capacity','capabilities']);
for (const file of files('src/lib/ledger').filter(p=>!p.slice('src/lib/ledger/'.length).includes('/') && !p.endsWith('.test.ts'))) {
  const stem = file.split('/').at(-1).replace('.ts','');
  if (infrastructure.has(stem)) continue;
  for (const name of exportsOf(read(file),file)) {
    if (/^[A-Z]/.test(name)) continue;
    if (!CAPABILITIES.some(c=>[c.core,c.read].some(ref=>ref?.module===file && ref.export===name))) problems.push(`${file}: unregistered core export ${name}`);
  }
}
if (problems.length) {
  console.error('check:capabilities failed:\n'+problems.map(p=>`  - ${p}`).join('\n'));
  process.exitCode=1;
} else console.log(`check:capabilities ok — ${CAPABILITIES.length} capabilities, ${actions.length} actions, ${tools.length} tools; native TypeScript import on ${process.version}`);
