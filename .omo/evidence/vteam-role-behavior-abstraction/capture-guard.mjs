/**
 * Built-in guard provenance harness (plan task 4: vteam-role-behavior-abstraction).
 *
 * Proves, WITHOUT a DB connection, that `guardForAgent()` no longer short-circuits
 * on the built-in name and instead resolves a built-in's `tools` / `bashDeny` from
 * its bound policy `config` (constant allowlist as fallback):
 *   (a) bound config.tools === the constant allowlist => emitted output deep-equals
 *       `.omo/evidence/.../before-agent-policies.json` (factory-state invariant);
 *   (b) bound config.tools ABSENT / all-illegal / non-object => the constant
 *       allowlist is used (never `{}`);
 *   (c) a built-in with a DIFFERING config.tools (one tool flipped to deny) => that
 *       value reaches `resolveByAgent().tools` (the DB edit is live at runtime);
 *   (d) a built-in with a DIFFERING config.bashDeny => that value reaches
 *       `resolveByAgent().bashDeny` (string[] filtered).
 *
 * Usage (from anywhere; server/ has ts-node):
 *   node capture-guard.mjs
 *
 * Output: task-4-guard.json (next to this script).
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

const { ExecutionPolicyService, builtinPolicyIdOf } = serverRequire(
  join(SERVER_ROOT, 'src/execution-policies/execution-policy.service.ts'),
);
const {
  ROLE_BOUNDARIES,
  ROLE_BASH_DENY_PATTERNS,
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

/** Service whose single-policy lookup returns the given policy (resolveByAgent path). */
function serviceResolveOne(policy) {
  return new ExecutionPolicyService(
    {
      agent: { findMany: () => Promise.resolve([]) },
      executionPolicy: { findUnique: () => Promise.resolve(policy) },
    },
    {},
  );
}

/** Service whose batch read returns the given rows (buildAgentPolicies path). */
function serviceBatch(rows) {
  return new ExecutionPolicyService(
    {
      agent: { findMany: () => Promise.resolve([]) },
      executionPolicy: { findMany: () => Promise.resolve(rows) },
    },
    {},
  );
}

const baseline = JSON.parse(
  readFileSync(join(HERE, 'before-agent-policies.json'), 'utf8'),
);
const baselineBytes = JSON.stringify(baseline);

const checks = {};
let allPass = true;
const record = (key, pass, detail) => {
  checks[key] = { pass, ...detail };
  allPass = allPass && pass;
};

// (a) every built-in bound row carries the factory config (== constant allowlist)
//     => output deep-equals the frozen baseline, and each built-in's tools come
//     from config (which here equals the constant).
{
  const rows = BUILTIN_ORDER.map((name) =>
    policyRow(
      name,
      store(reorderLikeMysql(factorySeedConfig(name))),
    ),
  );
  const policies = await serviceBatch(rows).buildAgentPolicies();
  const emitted = JSON.stringify(policies);
  const allToolsMatchConfig = BUILTIN_ORDER.every(
    (name) =>
      JSON.stringify(policies.guard.roles[name].tools) ===
      JSON.stringify(ROLE_BOUNDARIES[name].toolAllows),
  );
  record('factory_config_equals_baseline', emitted === baselineBytes, {
    emitted_equals_baseline: emitted === baselineBytes,
    all_tools_equal_constant_allowlist: allToolsMatchConfig,
    agent_order: policies.agents.map((a) => a.name),
  });
}

// (b) built-in bound row with config.tools ABSENT / all-illegal / non-object
//     => guard falls back to the constant allowlist, never `{}`.
{
  const cases = [];
  for (const name of ['vteam-product', 'vteam-tester', 'vteam-librarian']) {
    const base = factorySeedConfig(name);
    for (const [label, tools] of [
      ['absent', undefined],
      ['all-illegal', { bogus: 'whatever', also_bad: 1 }],
      ['non-object-array', []],
      ['non-object-string', 'nope'],
    ]) {
      const config =
        tools === undefined
          ? { permission: base.permission, correction: base.correction }
          : { permission: base.permission, correction: base.correction, tools };
      const resolved = await serviceResolveOne(
        policyRow(name, config),
      ).resolveByAgent({ role: name.replace(/^vteam-/, ''), policyId: builtinPolicyIdOf(name) });
      const resolvedTools = resolved?.tools ?? {};
      const ok =
        JSON.stringify(resolvedTools) ===
          JSON.stringify(ROLE_BOUNDARIES[name].toolAllows) &&
        Object.keys(resolvedTools).length > 0;
      cases.push({
        name,
        case: label,
        tool_count: Object.keys(resolvedTools).length,
        equals_constant_allowlist: ok,
      });
    }
  }
  record(
    'config_tools_missing_falls_back_to_constant_never_empty',
    cases.every((c) => c.equals_constant_allowlist),
    { cases },
  );
}

// (c) a built-in whose config.tools DIFFERS from the constant (one tool flipped
//     to deny) => that differing value reaches resolveByAgent().tools.
{
  const name = 'vteam-product';
  const constant = ROLE_BOUNDARIES[name].toolAllows;
  const flippedKey = Object.keys(constant).find(
    (key) => constant[key] === 'allow',
  );
  const dbTools = { ...constant, [flippedKey]: 'deny' };
  const base = factorySeedConfig(name);
  const resolved = await serviceResolveOne(
    policyRow(name, { ...base, tools: dbTools }),
  ).resolveByAgent({ role: 'product', policyId: builtinPolicyIdOf(name) });

  // same differing value must also flow through buildAgentPolicies
  const policies = await serviceBatch([
    policyRow(name, { ...base, tools: dbTools }),
  ]).buildAgentPolicies();
  const emittedBatch = policies.guard.roles[name].tools;

  record(
    'differing_config_tools_reach_resolveByAgent',
    resolved?.tools?.[flippedKey] === 'deny' &&
      resolved?.tools?.[flippedKey] !== constant[flippedKey] &&
      JSON.stringify(resolved?.tools) !== JSON.stringify(constant) &&
      JSON.stringify(emittedBatch) === JSON.stringify(resolved?.tools),
    {
      flipped_tool: flippedKey,
      constant_value: constant[flippedKey],
      resolveByAgent_value: resolved?.tools?.[flippedKey],
      buildAgentPolicies_value: emittedBatch?.[flippedKey],
      differing_db_tools_win: JSON.stringify(resolved?.tools) !== JSON.stringify(constant),
    },
  );
}

// (d) a built-in with a DIFFERING config.bashDeny => that value reaches
//     resolveByAgent().bashDeny (non-string entries filtered).
{
  const name = 'vteam-tester';
  const base = factorySeedConfig(name);
  const resolved = await serviceResolveOne(
    policyRow(name, {
      ...base,
      bashDeny: ['rm -rf /', 42, null, 'dd if='],
    }),
  ).resolveByAgent({ role: 'tester', policyId: builtinPolicyIdOf(name) });

  const missing = await serviceResolveOne(
    policyRow(name, { permission: base.permission, correction: base.correction }),
  ).resolveByAgent({ role: 'tester', policyId: builtinPolicyIdOf(name) });

  record(
    'config_bashDeny_reaches_guard_and_falls_back',
    JSON.stringify(resolved?.bashDeny) === JSON.stringify(['rm -rf /', 'dd if=']) &&
      JSON.stringify(missing?.bashDeny) === JSON.stringify([...ROLE_BASH_DENY_PATTERNS]),
    {
      differing_bashDeny: resolved?.bashDeny,
      absent_falls_back_to_constant: missing?.bashDeny,
      constant_patterns: [...ROLE_BASH_DENY_PATTERNS],
    },
  );
}

const doc = {
  _meta: {
    task: 'task-4-guard',
    plan: 'vteam-role-behavior-abstraction',
    kind: 'builtin-guard-config-provenance',
    proof:
      'guardForAgent() no longer short-circuits on built-in names: (a) a built-in whose bound config.tools equals the constant allowlist emits output byte-identical to before-agent-policies.json; (b) an absent/all-illegal/non-object config.tools falls back to the constant allowlist, never {}; (c) a differing config.tools (one tool flipped to deny) reaches resolveByAgent().tools AND buildAgentPolicies().guard.roles[].tools; (d) config.bashDeny reaches the guard and falls back to ROLE_BASH_DENY_PATTERNS when absent.',
    baseline: 'before-agent-policies.json (captured at HEAD f0b1924, sha256 793093dc5106a76a929f2e043dd5a53af35a2b902e2d929268f1665782abbc3a)',
    note: 'No DB connection opened; prisma lookups are stubbed in-process.',
  },
  allPass,
  checks,
};

writeFileSync(join(HERE, 'task-4-guard.json'), JSON.stringify(doc, null, 2) + '\n');
console.log('allPass:', allPass);
for (const [key, value] of Object.entries(checks)) {
  console.log(`  ${key}: ${value.pass ? 'PASS' : 'FAIL'}`);
}
process.exitCode = allPass ? 0 : 1;
