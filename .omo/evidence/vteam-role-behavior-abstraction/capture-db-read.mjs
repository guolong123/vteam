/**
 * DB-read provenance harness (plan task 3: vteam-role-behavior-abstraction).
 *
 * Proves, WITHOUT a DB connection, that `buildAgentPolicies()` now sources the 7
 * built-in roles from their bound policy rows (`ep_<role>`) via one batched
 * `findMany`, while staying byte-identical to the frozen baseline:
 *   (a) bound rows carrying the factory seed config => output JSON.stringify-equal
 *       to `.omo/evidence/.../before-agent-policies.json` (and the constant-derived
 *       output), even when the rows are returned in shuffled order and with MySQL
 *       JSON key ordering;
 *   (b) bound rows absent (findMany -> []) => constant fallback, no throw, still
 *       JSON.stringify-equal to the baseline;
 *   (c) a partial row (tools missing) => per-field constant fallback, non-empty tools;
 *   (d) a DB value that differs from the constant actually wins (proves the read path).
 *
 * Usage (from anywhere; server/ has ts-node):
 *   node capture-db-read.mjs
 *
 * Output: task-3-db-read.json (next to this script).
 */
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = resolve(HERE, '../../../server');
const serverRequire = createRequire(join(SERVER_ROOT, 'package.json'));

serverRequire('ts-node').register({
  transpileOnly: true,
  project: join(SERVER_ROOT, 'tsconfig.json'),
  compilerOptions: {
    module: 'commonjs',
    target: 'ES2021',
    experimentalDecorators: true,
    emitDecoratorMetadata: true,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    skipLibCheck: true,
  },
});
serverRequire('reflect-metadata');

const {
  ExecutionPolicyService,
  builtinPolicyIdOf,
} = serverRequire(
  join(SERVER_ROOT, 'src/execution-policies/execution-policy.service.ts'),
);
const {
  ROLE_BOUNDARIES,
  ROLE_POLICY_DENY_TEMPLATE,
  buildEditPermission,
  buildReadPermission,
} = serverRequire(join(SERVER_ROOT, 'src/common/constants/agent.constants.ts'));

const BUILTIN_ORDER = [
  'vteam-plan',
  'vteam-product',
  'vteam-architect',
  'vteam-developer',
  'vteam-tester',
  'vteam-project_manager',
  'vteam-librarian',
];

function factorySeedConfig(name) {
  const boundary = ROLE_BOUNDARIES[name];
  return {
    permission: {
      edit: buildEditPermission(boundary.writeGlobs),
      read: buildReadPermission(),
      bash: boundary.bashEffect,
      task: name === 'vteam-plan' ? 'allow' : 'deny',
      ...Object.fromEntries(boundary.mcpDenies.map((tool) => [tool, 'deny'])),
    },
    correction: {
      scopeSummary: boundary.scopeSummary,
      handoff: { ...boundary.handoffTo },
      denyTemplate: ROLE_POLICY_DENY_TEMPLATE,
    },
    tools: { ...boundary.toolAllows },
  };
}

/** MySQL native JSON column key order: shorter keys first, then bytewise. */
function reorderLikeMysql(value) {
  if (Array.isArray(value)) return value.map(reorderLikeMysql);
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort((a, b) =>
      a.length === b.length
        ? a < b
          ? -1
          : a > b
            ? 1
            : 0
        : a.length - b.length,
    );
    const out = {};
    for (const key of keys) out[key] = reorderLikeMysql(value[key]);
    return out;
  }
  return value;
}

const store = (v) => JSON.parse(JSON.stringify(v));

function policyRow(name, config) {
  return {
    id: builtinPolicyIdOf(name),
    name: `policy-${name}`,
    description: null,
    type: 'template',
    config,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

function rowsFor(order, configOf) {
  return order.map((name) =>
    policyRow(name, store(reorderLikeMysql(configOf ? configOf(name) : factorySeedConfig(name)))),
  );
}

function serviceWith(findManyImpl) {
  const findMany = function (...args) {
    return findManyImpl(...args);
  };
  return new ExecutionPolicyService(
    {
      agent: { findMany: () => Promise.resolve([]) },
      executionPolicy: { findMany },
    },
    {},
  );
}

const baselineRaw = readFileSync(
  join(HERE, 'before-agent-policies.json'),
  'utf8',
);
const baseline = JSON.parse(baselineRaw);
const baselineBytes = JSON.stringify(baseline);

const checks = {};
let allPass = true;
const record = (key, pass, detail) => {
  checks[key] = { pass, ...detail };
  allPass = allPass && pass;
};

// (a) bound rows carry factory config, returned in AGENT_POLICIES_ORDER.
{
  let seenWhere = null;
  let calls = 0;
  const service = serviceWith(({ where }) => {
    calls += 1;
    seenWhere = where;
    return Promise.resolve(rowsFor(BUILTIN_ORDER));
  });
  const policies = await service.buildAgentPolicies();
  const emitted = JSON.stringify(policies);
  record('factory_rows_equals_baseline', emitted === baselineBytes, {
    emitted_equals_baseline: emitted === baselineBytes,
    agent_order: policies.agents.map((a) => a.name),
    guard_role_order: Object.keys(policies.guard.roles),
    guard_enabled: policies.guard.enabled,
  });
  record(
    'single_batch_findmany',
    calls === 1 &&
      JSON.stringify([...seenWhere.id.in].sort()) ===
        JSON.stringify(BUILTIN_ORDER.map((n) => builtinPolicyIdOf(n)).sort()),
    { findMany_calls: calls, requested_ids: seenWhere?.id?.in },
  );
}

// (a2) bound rows returned in shuffled order -> emission order stays the constant.
{
  const shuffled = [...BUILTIN_ORDER].reverse();
  const policies = await serviceWith(() =>
    Promise.resolve(rowsFor(shuffled)),
  ).buildAgentPolicies();
  record(
    'shuffled_rows_keep_constant_order',
    JSON.stringify(policies) === baselineBytes &&
      JSON.stringify(policies.agents.map((a) => a.name)) ===
        JSON.stringify(BUILTIN_ORDER),
    {
      emitted_equals_baseline: JSON.stringify(policies) === baselineBytes,
      agent_order: policies.agents.map((a) => a.name),
    },
  );
}

// (b) all bound rows absent -> constant fallback, no throw.
{
  let threw = null;
  let policies = null;
  try {
    policies = await serviceWith(() => Promise.resolve([])).buildAgentPolicies();
  } catch (err) {
    threw = String(err);
  }
  record(
    'missing_rows_constant_fallback_no_throw',
    threw === null && JSON.stringify(policies) === baselineBytes,
    {
      threw,
      emitted_equals_baseline:
        threw === null && JSON.stringify(policies) === baselineBytes,
      agents_emitted: policies ? policies.agents.length : null,
    },
  );
}

// (b2) partial row: config present but tools missing -> non-empty constant tools.
{
  let threw = null;
  let toolCount = null;
  let equalsConstant = null;
  try {
    const config = factorySeedConfig('vteam-tester');
    const policies = await serviceWith(() =>
      Promise.resolve([
        policyRow('vteam-tester', {
          permission: config.permission,
          correction: config.correction,
        }),
      ]),
    ).buildAgentPolicies();
    const tools = policies.guard.roles['vteam-tester'].tools;
    toolCount = Object.keys(tools).length;
    equalsConstant =
      JSON.stringify(tools) ===
      JSON.stringify(ROLE_BOUNDARIES['vteam-tester'].toolAllows);
  } catch (err) {
    threw = String(err);
  }
  record(
    'partial_row_tools_falls_back_non_empty',
    threw === null && equalsConstant === true && toolCount > 0,
    { threw, tool_count: toolCount, equals_constant_tool_allows: equalsConstant },
  );
}

// (d) DB value that differs from the constant actually wins (proves the read path).
{
  const config = factorySeedConfig('vteam-product');
  const dbTools = { vteam_group_post: 'deny', vteam_memory_search: 'ask' };
  const policies = await serviceWith(() =>
    Promise.resolve([
      policyRow('vteam-product', { ...config, tools: dbTools }),
    ]),
  ).buildAgentPolicies();
  const emitted = policies.guard.roles['vteam-product'].tools;
  record(
    'db_value_wins_over_constant',
    JSON.stringify(emitted) === JSON.stringify(dbTools) &&
      JSON.stringify(emitted) !==
        JSON.stringify(ROLE_BOUNDARIES['vteam-product'].toolAllows),
    { emitted_tools: emitted, db_tools: dbTools },
  );
}

const doc = {
  _meta: {
    task: 'task-3-db-read',
    plan: 'vteam-role-behavior-abstraction',
    kind: 'db-read-builtin-provenance',
    proof:
      'buildAgentPolicies() batch-reads the bound ep_<role> rows (single findMany) and resolves each built-in via resolveBuiltinPolicy; factory rows reproduce before-agent-policies.json byte-for-byte, shuffled row order does not change emission order, missing/partial rows fall back to constants without throwing, and a differing DB value wins.',
    baseline: 'before-agent-policies.json (captured at HEAD f0b1924)',
    note: 'No DB connection opened; prisma.executionPolicy.findMany is stubbed in-process.',
  },
  allPass,
  checks,
};

writeFileSync(join(HERE, 'task-3-db-read.json'), JSON.stringify(doc, null, 2) + '\n');
console.log('allPass:', allPass);
for (const [key, value] of Object.entries(checks)) {
  console.log(`  ${key}: ${value.pass ? 'PASS' : 'FAIL'}`);
}
process.exitCode = allPass ? 0 : 1;
