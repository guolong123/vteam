#!/usr/bin/env node
/**
 * verify-prompt-classification.mjs — todo 2 gate for the agent-role-entity plan.
 *
 * Classifies NOTHING. It re-derives the 7 rendered prompts straight from
 * server/prisma/seed.ts, re-reads the checked-in classification artifact, and
 * proves the mapping is complete and self-consistent:
 *
 *   1. per-agent and total source-line count == classified-line count;
 *   2. every line index 0..N-1 appears exactly once (no unclassified, no dup);
 *   3. every destination is exactly one of role|agent|platform|removed-intentionally;
 *   4. every classified line's text equals the reconstructed source line at that index;
 *   5. the named blocks are marked: 团队协作规约 x7 platform, 回执铁律 x4 platform,
 *      派发铁律 x1 + 修订铁律 x1 role-specific, and the dropped 权限 prose is enumerated.
 *
 * Exit 0 = complete mapping. Exit 1 = a line is unclassified / drifted / duplicated.
 *
 * Usage: node scripts/verify-prompt-classification.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SEED = path.join(ROOT, 'server/prisma/seed.ts');
const ARTIFACT = path.join(
  ROOT,
  '.omo/evidence/agent-role-entity/task-2-classification.json',
);

const VALID_DESTS = new Set([
  'role',
  'agent',
  'platform',
  'removed-intentionally',
]);

const failures = [];
const fail = (msg) => failures.push(msg);

// ---------------------------------------------------------------------------
// Re-derive the rendered prompts from seed.ts (same predicate as the artifact).
// ---------------------------------------------------------------------------
const seed = fs.readFileSync(SEED, 'utf8');

function derivePlanToolLine() {
  const i = seed.indexOf("'vteam-plan': defineBoundary({");
  if (i < 0) throw new Error("seed.ts: vteam-plan boundary not found");
  const toolAllowsAt = seed.indexOf('toolAllows: {', i);
  const end = seed.indexOf('},', toolAllowsAt);
  const body = seed.slice(seed.indexOf('{', toolAllowsAt) + 1, end);
  const keys = [...body.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)].map(
    (m) => m[1],
  );
  if (keys.length === 0) throw new Error('seed.ts: plan toolAllows empty');
  return '可用工具：' + keys.join(' / ') + '。';
}

function renderPrompts() {
  const startMarker = 'const templateAgents = [';
  const start = seed.indexOf(startMarker);
  if (start < 0) throw new Error('seed.ts: templateAgents array not found');
  const end = seed.indexOf('\n  ];', start) + 4;
  const literal = seed.slice(start + 'const templateAgents = '.length, end);
  // The array literal's only external reference is planToolLine.
  const agents = new Function('planToolLine', `return (${literal});`)(
    derivePlanToolLine(),
  );
  return agents.map((a) => ({
    key: a.role,
    id: a.id,
    name: a.name,
    lines: a.prompt.split('\n'),
  }));
}

// ---------------------------------------------------------------------------
// Compare.
// ---------------------------------------------------------------------------
const source = renderPrompts();
const artifact = JSON.parse(fs.readFileSync(ARTIFACT, 'utf8'));

if (source.length !== 7) fail(`seed.ts has ${source.length} prompts, expected 7`);

const artifactByKey = new Map(
  (artifact.agents ?? []).map((a) => [a.key, a]),
);

let sourceTotal = 0;
let classifiedTotal = 0;
const destTotals = { role: 0, agent: 0, platform: 0, 'removed-intentionally': 0 };

for (const agent of source) {
  sourceTotal += agent.lines.length;
  const entry = artifactByKey.get(agent.key);
  if (!entry) {
    fail(`artifact missing agent '${agent.key}'`);
    continue;
  }
  if (entry.sourceLineCount !== agent.lines.length) {
    fail(
      `agent '${agent.key}': artifact sourceLineCount ${entry.sourceLineCount} != seed ${agent.lines.length}`,
    );
  }

  const seen = new Map();
  for (const line of entry.lines ?? []) {
    classifiedTotal++;
    if (!VALID_DESTS.has(line.dest)) {
      fail(`agent '${agent.key}' line ${line.i}: invalid destination '${line.dest}'`);
    }
    if (seen.has(line.i)) {
      fail(`agent '${agent.key}' line ${line.i}: duplicate classification`);
    }
    seen.set(line.i, line.dest);
    destTotals[line.dest] = (destTotals[line.dest] ?? 0) + 1;

    const expectedText = agent.lines[line.i];
    if (expectedText === undefined) {
      fail(`agent '${agent.key}' line ${line.i}: index out of range`);
    } else if (line.text !== expectedText) {
      fail(
        `agent '${agent.key}' line ${line.i}: text drift\n  seed:     ${JSON.stringify(expectedText)}\n  artifact: ${JSON.stringify(line.text)}`,
      );
    }
  }

  for (let i = 0; i < agent.lines.length; i++) {
    if (!seen.has(i)) {
      fail(
        `agent '${agent.key}' line ${i}: UNCLASSIFIED -> ${JSON.stringify(agent.lines[i])}`,
      );
    }
  }
  if (entry.classifiedLineCount !== seen.size) {
    fail(
      `agent '${agent.key}': classifiedLineCount ${entry.classifiedLineCount} != entries ${seen.size}`,
    );
  }
}

if (classifiedTotal !== sourceTotal) {
  fail(`TOTAL source ${sourceTotal} != classified ${classifiedTotal}`);
}

// ---------------------------------------------------------------------------
// Named-block assertions.
// ---------------------------------------------------------------------------
const destOf = (key, i) => {
  const entry = artifactByKey.get(key);
  return entry?.lines?.find((l) => l.i === i)?.dest;
};
const textOf = (key, i) => {
  const entry = artifactByKey.get(key);
  return entry?.lines?.find((l) => l.i === i)?.text ?? '';
};

const countContains = (needle, dest) =>
  (artifact.agents ?? []).reduce(
    (n, a) => n + (a.lines ?? []).filter((l) => l.dest === dest && l.text.includes(needle)).length,
    0,
  );

const charterCount = countContains('团队协作规约（全文见', 'platform');
if (charterCount !== 7) fail(`团队协作规约 platform-marked count ${charterCount} != 7`);
const receiptCount = countContains('## 回执铁律', 'platform');
if (receiptCount !== 4) fail(`回执铁律 platform-marked count ${receiptCount} != 4`);
const dispatchCount = artifact.agents.reduce(
  (n, a) => n + a.lines.filter((l) => l.text.startsWith('## 派发铁律')).length,
  0,
);
if (dispatchCount !== 1) fail(`派发铁律 count ${dispatchCount} != 1`);
const dispatchDest = destOf('project_manager', 34);
if (dispatchDest !== 'agent')
  fail(`派发铁律 (project_manager:34) destination '${dispatchDest}' != agent (role-specific)`);
const revisionCount = artifact.agents.reduce(
  (n, a) => n + a.lines.filter((l) => l.text.startsWith('## 修订铁律')).length,
  0,
);
if (revisionCount !== 1) fail(`修订铁律 count ${revisionCount} != 1`);
const revisionDest = destOf('plan', 37);
if (revisionDest !== 'agent')
  fail(`修订铁律 (plan:37) destination '${revisionDest}' != agent (role-specific)`);

// The dropped 权限 prose must be explicitly enumerated as removed-intentionally.
const removed = (artifact.agents ?? []).flatMap((a) =>
  (a.lines ?? [])
    .filter((l) => l.dest === 'removed-intentionally')
    .map((l) => ({ agent: a.key, index: l.i, text: l.text })),
);
const expectedRemoved = {
  product: [12, 13, 15],
  project_manager: [12, 14],
  architect: [10, 11, 13],
  developer: [10, 11, 13],
  tester: [11, 12, 14],
  plan: [11, 12, 13, 15],
  librarian: [10, 12],
};
for (const [key, indexes] of Object.entries(expectedRemoved)) {
  const got = removed.filter((r) => r.agent === key).map((r) => r.index).sort((a, b) => a - b);
  const want = [...indexes].sort((a, b) => a - b);
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    fail(`removed-intentionally for '${key}': got [${got}] want [${want}]`);
  }
}
if (!artifact.replacementPointer?.canonical?.includes('ExecutionPolicy')) {
  fail('artifact.replacementPointer.canonical missing (O6 pointer not recorded)');
}
if (removed.some((r) => !r.text.includes('## ') && r.text.trim() === '')) {
  fail('a blank line was marked removed-intentionally (blank must follow its section)');
}

// Every documented block occurrence is actually present in the artifact.
for (const [name, block] of Object.entries(artifact.blocks ?? {})) {
  for (const occ of block.occurrences ?? []) {
    const dest = destOf(occ.agent, occ.logicalIndex);
    const text = textOf(occ.agent, occ.logicalIndex);
    if (dest !== block.dest) {
      fail(`${name} ${occ.agent}:${occ.logicalIndex} dest '${dest}' != '${block.dest}'`);
    }
    if (!text.includes(block.marker)) {
      fail(`${name} ${occ.agent}:${occ.logicalIndex} text missing marker '${block.marker}'`);
    }
  }
}

// ---------------------------------------------------------------------------
// Report.
// ---------------------------------------------------------------------------
console.log('prompt classification check');
console.log('  artifact :', path.relative(ROOT, ARTIFACT));
console.log('  source   :', path.relative(ROOT, SEED));
for (const agent of source) {
  const entry = artifactByKey.get(agent.key) ?? { classifiedLineCount: 0 };
  console.log(
    `  ${agent.key.padEnd(18)} source=${String(agent.lines.length).padStart(3)} classified=${String(entry.classifiedLineCount).padStart(3)}`,
  );
}
console.log(
  `  TOTAL              source=${sourceTotal} classified=${classifiedTotal} ${sourceTotal === classifiedTotal ? 'EQUAL' : 'MISMATCH'}`,
);
console.log('  by destination  :', destTotals);
console.log(
  `  blocks          : 团队协作规约=${charterCount}/7 platform, 回执铁律=${receiptCount}/4 platform, 派发铁律=${dispatchCount}/1 role-specific, 修订铁律=${revisionCount}/1 role-specific`,
);
console.log(`  removed(lines)  : ${removed.length} enumerated (intentional)`);

if (failures.length > 0) {
  console.error('\nFAIL:');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('\nOK: 100% of prompt lines classified (source == classified).');
