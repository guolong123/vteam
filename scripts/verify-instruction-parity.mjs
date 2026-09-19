#!/usr/bin/env node
/**
 * verify-instruction-parity.mjs — POST-SPLIT parity gate for the agent-role-entity plan (todo 8).
 *
 * Replaces the stale pre-split classifier `scripts/verify-prompt-classification.mjs`
 * (that script compares its classification against the REMOVED pre-split `seed.ts`; it can
 * never pass post-split and must never be used as a gate — see `retired-by:` below).
 *
 * Source of truth: `.omo/evidence/agent-role-entity/task-2-classification.json` (todo 2 oracle),
 * which classifies every PRE-SPLIT rendered prompt line into exactly one destination:
 *   role | agent | platform | removed-intentionally
 *
 * This checker proves the POST-SPLIT sources account for every pre-split line
 * EXACTLY ONCE across {role part, agent part, platform part, intentionally-removed}:
 *
 *   role part     = server/src/common/constants/agent-role-prompts.constants.ts
 *                   BUILTIN_ROLE_PROMPTS[key]  (7 builtin rolePrompt values)
 *   agent part    = server/prisma/seed.ts templateAgents[].prompt  (7 agent prompts)
 *   platform part = server/src/chat/worker-dispatcher.ts
 *                   TEAM_COLLABORATION_CHARTER_LINES + AGENT_RECEIPT_IRON_LAW_LINES
 *                   (ONE shared constant, injected for all 7 — the 7x/4x copies are gone)
 *   removed       = the 20 enumerated `## 权限` prose lines, deliberately dropped and
 *                   replaced by the canonical ExecutionPolicy pointer (O6 decision)
 *
 * Assertions:
 *   1. every oracle role line appears exactly once in its own role prompt;
 *   2. every oracle agent line appears exactly once in its own agent prompt;
 *   3. every oracle platform line appears exactly once in the shared platform constants,
 *      and ZERO times in any agent/role prompt (the dedup win: 55 occurrences -> 9 lines);
 *   4. every oracle removed-intentionally line appears ZERO times in live content and is
 *      enumerated in the oracle's removed set; the canonical pointer is present where the
 *      `addWhereMissing` mapping requires it;
 *   5. no live non-blank role/agent line is unaccounted for beyond the documented additive
 *      pointer line (`replacementPointer.addWhereMissing`);
 *   6. the constants-file role prompts and the seed's self-contained mirror are byte-identical;
 *   7. the platform constants are defined exactly once in worker-dispatcher.ts.
 *
 * Exit 0 = 0 lost, 0 duplicated, 0 unaccounted. Exit 1 = any lost/duplicated/unaccounted line.
 *
 * Usage: node scripts/verify-instruction-parity.mjs
 *
 * retired-by: this file supersedes scripts/verify-prompt-classification.mjs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ORACLE = path.join(
  ROOT,
  '.omo/evidence/agent-role-entity/task-2-classification.json',
);
const SEED = path.join(ROOT, 'server/prisma/seed.ts');
const ROLE_CONSTANTS = path.join(
  ROOT,
  'server/src/common/constants/agent-role-prompts.constants.ts',
);
const DISPATCHER = path.join(ROOT, 'server/src/chat/worker-dispatcher.ts');

const CANONICAL_POINTER =
  '- 可用工具以 ExecutionPolicy/【职责边界】为准，越界调用会被直接拒绝。';

const failures = [];
const fail = (msg) => failures.push(msg);

const read = (p) => fs.readFileSync(p, 'utf8');

// ---------------------------------------------------------------------------
// Literal extraction (no TS execution: pull the literal text and eval it).
// ---------------------------------------------------------------------------
function sliceArrayLiteral(src, marker) {
  const at = src.indexOf(marker);
  if (at < 0) throw new Error(`literal marker not found: ${marker}`);
  const open = src.indexOf('[', at);
  const m = /\n[ \t]*\];/.exec(src.slice(open));
  if (open < 0 || !m) throw new Error(`unterminated array: ${marker}`);
  const close = open + m.index + m[0].length;
  return src.slice(open, close - 1); // drop the trailing `;` so it evals as an expression
}

function sliceObjectLiteral(src, marker) {
  const at = src.indexOf(marker);
  if (at < 0) throw new Error(`literal marker not found: ${marker}`);
  const open = src.indexOf('{', at);
  const close = src.indexOf('\n};', open);
  if (open < 0 || close < 0) throw new Error(`unterminated object: ${marker}`);
  return src.slice(open, close + 2); // include `}`
}

function evalLiteral(literal, externals = {}) {
  const names = Object.keys(externals);
  const fn = new Function(...names, `return (${literal});`);
  return fn(...names.map((n) => externals[n]));
}

// seed.ts: re-derive the rendered templateAgents[].prompt values.
const seedSrc = read(SEED);
function derivePlanToolLine() {
  const i = seedSrc.indexOf("'vteam-plan': defineBoundary({");
  if (i < 0) throw new Error('seed.ts: vteam-plan boundary not found');
  const toolAllowsAt = seedSrc.indexOf('toolAllows: {', i);
  const end = seedSrc.indexOf('},', toolAllowsAt);
  const body = seedSrc.slice(seedSrc.indexOf('{', toolAllowsAt) + 1, end);
  const keys = [...body.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)].map(
    (m) => m[1],
  );
  return '可用工具：' + keys.join(' / ') + '。';
}
const templateAgents = evalLiteral(
  sliceArrayLiteral(seedSrc, 'const templateAgents = ['),
  { planToolLine: derivePlanToolLine() },
);
const seedAgentPrompts = new Map(
  templateAgents.map((a) => [a.role, a.prompt.split('\n')]),
);
const seedRoleMirror = evalLiteral(
  sliceObjectLiteral(seedSrc, 'const BUILTIN_ROLE_PROMPTS'),
  {},
);

// role constants: BUILTIN_ROLE_PROMPTS[key] = rolePrompt.
const roleSrc = read(ROLE_CONSTANTS);
const rolePrompts = evalLiteral(
  sliceObjectLiteral(roleSrc, 'export const BUILTIN_ROLE_PROMPTS'),
  {},
);

// platform constants: two arrays, each ONE source (not 7 copies).
const dispatcherSrc = read(DISPATCHER);
const charterLines = evalLiteral(
  sliceArrayLiteral(dispatcherSrc, 'export const TEAM_COLLABORATION_CHARTER_LINES = ['),
  {},
);
const receiptLines = evalLiteral(
  sliceArrayLiteral(dispatcherSrc, 'export const AGENT_RECEIPT_IRON_LAW_LINES = ['),
  {},
);
const platformLines = [...charterLines, ...receiptLines];

// ---------------------------------------------------------------------------
// Oracle.
// ---------------------------------------------------------------------------
const oracle = JSON.parse(read(ORACLE));
const oracleByKey = new Map(oracle.agents.map((a) => [a.key, a]));

const DEST_ROLE = 'role';
const DEST_AGENT = 'agent';
const DEST_PLATFORM = 'platform';
const DEST_REMOVED = 'removed-intentionally';

// Documented additive pointer: the oracle dropped plan's enumerated tool list and the
// post-split seed ADDS the canonical pointer (replacementPointer.addWhereMissing).
const additivePointerAgents = new Set(
  (oracle.replacementPointer?.addWhereMissing ?? []).map((x) => x.agent),
);

const occurrences = (haystack, needle) =>
  needle === '' ? 0 : haystack.filter((l) => l === needle).length;

// ---------------------------------------------------------------------------
// Per-agent accounting.
// ---------------------------------------------------------------------------
const stats = {
  lost: [],
  duplicated: [],
  unaccounted: [],
  removedPresent: [],
  platformInPrompt: [],
  pointerMissing: [],
  roleRebuildMismatch: [],
  agentRebuildMismatch: [],
  platformRebuildMismatch: [],
};

// Documented additive pointer agents (the oracle dropped their enumerated tool list and
// the post-split source ADDS the canonical pointer — `replacementPointer.addWhereMissing`).
let oracleRoleTotal = 0;
let oracleAgentTotal = 0;
let oraclePlatformTotal = 0;
let oracleRemovedTotal = 0;

for (const entry of oracle.agents) {
  const key = entry.key;
  const roleLines = rolePrompts[key];
  const agentLines = seedAgentPrompts.get(key);
  if (typeof roleLines !== 'string') {
    fail(`agent '${key}': role prompt missing from BUILTIN_ROLE_PROMPTS`);
    continue;
  }
  if (!agentLines) {
    fail(`agent '${key}': agent prompt missing from seed templateAgents`);
    continue;
  }
  const roleArr = roleLines.split('\n');
  const ownContent = [...roleArr, ...agentLines];

  // --- Exact byte-reconstruction (the strongest parity form) ---
  // role: the oracle's role lines, in order, reproduce the live rolePrompt byte for byte.
  const reconRole = entry.lines
    .filter((l) => l.dest === DEST_ROLE)
    .map((l) => l.text)
    .join('\n');
  if (reconRole !== roleLines) {
    stats.roleRebuildMismatch.push(key);
  }
  // agent: the oracle's agent lines, in order, reproduce the live agent prompt byte for
  // byte once the single documented additive canonical pointer is set aside (the pointer
  // replaced the removed enumerated tool list — `replacementPointer.addWhereMissing`).
  const oracleAgent = entry.lines
    .filter((l) => l.dest === DEST_AGENT)
    .map((l) => l.text);
  const liveSansPointer = agentLines.filter((l) => l !== CANONICAL_POINTER);
  const oracleSansPointer = oracleAgent.filter((l) => l !== CANONICAL_POINTER);
  if (JSON.stringify(liveSansPointer) !== JSON.stringify(oracleSansPointer)) {
    stats.agentRebuildMismatch.push(key);
  }
  // platform: this agent's platform-dest non-blank lines must be a subset of the shared
  // platform constant (the 7x/4x copies collapsed to one).
  const oraclePlatformContent = entry.lines
    .filter((l) => l.dest === DEST_PLATFORM && l.text !== undefined && l.text.trim() !== '')
    .map((l) => l.text);
  for (const t of new Set(oraclePlatformContent)) {
    if (!platformLines.includes(t)) {
      stats.platformRebuildMismatch.push(`${key} ${JSON.stringify(t.slice(0, 40))}`);
    }
  }

  for (const line of entry.lines) {
    const text = line.text;
    const isBlank = text === undefined || text.trim() === '';
    if (line.dest === DEST_ROLE) {
      oracleRoleTotal++;
      if (isBlank) continue;
      const n = occurrences(roleArr, text) + occurrences(agentLines, text);
      if (n === 0) stats.lost.push(`${key}:role:${line.i} ${JSON.stringify(text.slice(0, 60))}`);
      else if (n > 1) stats.duplicated.push(`${key}:role:${line.i} x${n}`);
    } else if (line.dest === DEST_AGENT) {
      oracleAgentTotal++;
      if (isBlank) continue;
      const n = occurrences(roleArr, text) + occurrences(agentLines, text);
      if (n === 0) stats.lost.push(`${key}:agent:${line.i} ${JSON.stringify(text.slice(0, 60))}`);
      else if (n > 1) stats.duplicated.push(`${key}:agent:${line.i} x${n}`);
    } else if (line.dest === DEST_PLATFORM) {
      oraclePlatformTotal++;
      if (isBlank) continue;
      const inPlatform = occurrences(platformLines, text);
      if (inPlatform === 0) {
        stats.lost.push(`${key}:platform:${line.i} ${JSON.stringify(text.slice(0, 60))}`);
      }
      // platform text must have been MOVED OUT of the per-agent prompts.
      const inPrompt = occurrences(ownContent, text);
      if (inPrompt > 0) {
        stats.platformInPrompt.push(`${key}:platform:${line.i} x${inPrompt}`);
      }
    } else if (line.dest === DEST_REMOVED) {
      oracleRemovedTotal++;
      if (isBlank) continue;
      const inLive = occurrences(ownContent, text);
      if (inLive > 0) {
        stats.removedPresent.push(`${key}:removed:${line.i} x${inLive}`);
      }
    } else {
      fail(`agent '${key}' line ${line.i}: unknown destination '${line.dest}'`);
    }
  }

  // Unaccounted: any non-blank live role/agent line the oracle never classified.
  const known = new Set(
    entry.lines
      .filter((l) => l.dest === DEST_ROLE || l.dest === DEST_AGENT)
      .map((l) => l.text)
      .filter((t) => t !== undefined && t.trim() !== ''),
  );
  const additions = additivePointerAgents.has(key) ? new Set([CANONICAL_POINTER]) : new Set();
  for (const [bucket, lines] of [['role', roleArr], ['agent', agentLines]]) {
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i];
      if (t.trim() === '') continue;
      if (!known.has(t) && !additions.has(t)) {
        stats.unaccounted.push(`${key}:${bucket}:${i} ${JSON.stringify(t.slice(0, 60))}`);
      }
    }
  }

  // The canonical pointer must be present for every agent whose oracle kept it OR whose
  // mapping documents the additive pointer.
  const keptPointer = entry.lines.some(
    (l) => l.dest === DEST_AGENT && l.text === CANONICAL_POINTER,
  );
  const needsPointer = keptPointer || additivePointerAgents.has(key);
  if (needsPointer && !ownContent.includes(CANONICAL_POINTER)) {
    stats.pointerMissing.push(key);
  }

  // constants-file role prompt and seed's self-contained mirror must be byte-identical.
  const mirror = seedRoleMirror[key];
  if (typeof mirror !== 'string') {
    fail(`seed.ts BUILTIN_ROLE_PROMPTS missing '${key}'`);
  } else if (mirror !== roleLines) {
    fail(`agent '${key}': seed mirror rolePrompt != constants-file rolePrompt`);
  }
}

// ---------------------------------------------------------------------------
// Global reconciliation + duplication checks.
// ---------------------------------------------------------------------------
const byDest = oracle.totals?.byDestination ?? {};
if (oracleRoleTotal !== byDest[DEST_ROLE]) {
  fail(`oracle role total ${oracleRoleTotal} != ${byDest[DEST_ROLE]}`);
}
if (oracleAgentTotal !== byDest[DEST_AGENT]) {
  fail(`oracle agent total ${oracleAgentTotal} != ${byDest[DEST_AGENT]}`);
}
if (oraclePlatformTotal !== byDest[DEST_PLATFORM]) {
  fail(`oracle platform total ${oraclePlatformTotal} != ${byDest[DEST_PLATFORM]}`);
}
if (oracleRemovedTotal !== byDest[DEST_REMOVED]) {
  fail(`oracle removed total ${oracleRemovedTotal} != ${byDest[DEST_REMOVED]}`);
}

// The platform block must exist exactly ONCE in code: the constants hold the unique
// platform content, each line exactly once, and the seed prompts carry none of it.
const uniquePlatform = [...new Set(platformLines.filter((l) => l.trim() !== ''))];
const duplicatedPlatform = uniquePlatform.filter((l) => occurrences(platformLines, l) > 1);
if (duplicatedPlatform.length > 0) {
  fail(`platform constant contains duplicated lines: ${duplicatedPlatform.length}`);
}
if (platformLines.filter((l) => l.trim() !== '').length !== uniquePlatform.length) {
  fail('platform constant contains repeated lines (expected each platform line once)');
}
if (charterLines.length !== 5) fail(`charter constant has ${charterLines.length} lines, expected 5`);
if (receiptLines.length !== 4) fail(`receipt constant has ${receiptLines.length} lines, expected 4`);

const charterExport = dispatcherSrc.match(/export const TEAM_COLLABORATION_CHARTER_LINES\b/g)?.length ?? 0;
const receiptExport = dispatcherSrc.match(/export const AGENT_RECEIPT_IRON_LAW_LINES\b/g)?.length ?? 0;
if (charterExport !== 1) fail(`TEAM_COLLABORATION_CHARTER_LINES defined ${charterExport}x (want 1)`);
if (receiptExport !== 1) fail(`AGENT_RECEIPT_IRON_LAW_LINES defined ${receiptExport}x (want 1)`);

// ---------------------------------------------------------------------------
// Report.
// ---------------------------------------------------------------------------
const lost = stats.lost.length;
const duplicated = stats.duplicated.length;
const unaccounted = stats.unaccounted.length;

console.log('instruction parity check (post-split)');
console.log('  oracle   :', path.relative(ROOT, ORACLE));
console.log('  role     :', path.relative(ROOT, ROLE_CONSTANTS));
console.log('  agent    :', path.relative(ROOT, SEED));
console.log('  platform :', path.relative(ROOT, DISPATCHER));
console.log('');
console.log('  pre-split lines by destination (oracle):');
console.log(
  `    role=${oracleRoleTotal} agent=${oracleAgentTotal} platform=${oraclePlatformTotal} removed-intentionally=${oracleRemovedTotal} total=${oracleRoleTotal + oracleAgentTotal + oraclePlatformTotal + oracleRemovedTotal}`,
);
console.log('  post-split live content:');
console.log(
  `    role prompts=${Object.keys(rolePrompts).length} agent prompts=${seedAgentPrompts.size} platform constant lines=${platformLines.length} (unique content ${uniquePlatform.length})`,
);
console.log(`    platform oracle occurrences ${oraclePlatformTotal} collapse to ${uniquePlatform.length} shared constant lines`);
console.log('');
console.log(`  LOST        : ${lost}`);
for (const l of stats.lost) console.log(`    - ${l}`);
console.log(`  DUPLICATED  : ${duplicated}`);
for (const d of stats.duplicated) console.log(`    - ${d}`);
console.log(`  UNACCOUNTED : ${unaccounted}`);
for (const u of stats.unaccounted) console.log(`    - ${u}`);
console.log(`  removed-intentionally still present in live content : ${stats.removedPresent.length}`);
for (const r of stats.removedPresent) console.log(`    - ${r}`);
console.log(`  platform text still inside an agent/role prompt     : ${stats.platformInPrompt.length}`);
for (const p of stats.platformInPrompt) console.log(`    - ${p}`);
console.log(`  canonical pointer missing                           : ${stats.pointerMissing.length}`);
for (const p of stats.pointerMissing) console.log(`    - ${p}`);
console.log(`  role prompt byte-rebuild mismatches                 : ${stats.roleRebuildMismatch.length}`);
for (const p of stats.roleRebuildMismatch) console.log(`    - ${p}`);
console.log(`  agent prompt byte-rebuild mismatches                : ${stats.agentRebuildMismatch.length}`);
for (const p of stats.agentRebuildMismatch) console.log(`    - ${p}`);
console.log(`  platform content not in shared constant             : ${stats.platformRebuildMismatch.length}`);
for (const p of stats.platformRebuildMismatch) console.log(`    - ${p}`);
console.log(`  documented additive pointer agents                  : ${[...additivePointerAgents].join(', ') || '(none)'}`);
console.log(`  oracle removed-intentionally enumerated             : ${oracle.replacementPointer?.removedLineCount ?? '?'}`);

if (failures.length > 0) {
  console.error('\nFAIL:');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
const violationCount =
  lost +
  duplicated +
  unaccounted +
  stats.platformInPrompt.length +
  stats.removedPresent.length +
  stats.pointerMissing.length +
  stats.roleRebuildMismatch.length +
  stats.agentRebuildMismatch.length +
  stats.platformRebuildMismatch.length;
if (violationCount > 0) {
  console.error('\nFAIL: parity violated (see counts above).');
  process.exit(1);
}
console.log('\nOK: 0 lost, 0 duplicated, 0 unaccounted — every pre-split line lands in exactly one destination.');
