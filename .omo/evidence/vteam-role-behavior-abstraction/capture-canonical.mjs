/**
 * Canonical-emission provenance harness (plan task 2: vteam-role-behavior-abstraction).
 *
 * Proves the core inversion invariant WITHOUT touching the DB: a policy `config`
 * that has been stored in a MySQL native `JSON` column (which reorders object keys
 * by key-length then bytewise) resolves, via `resolveBuiltinPolicy`, to an object
 * whose `JSON.stringify` is byte-identical to BOTH:
 *   (a) the constant-derived output (independent, from ROLE_BOUNDARIES), and
 *   (b) the frozen baseline `.omo/evidence/.../before-agent-policies.json`
 *       captured at HEAD f0b1924 from the real pre-change service.
 *
 * Also records the write-time normalization results (permission.write dropped,
 * illegal tools values dropped, bashDeny coerced to string[]).
 *
 * Read-only w.r.t. product code and DB. Usage (from anywhere; server/ has ts-node):
 *   node capture-canonical.mjs
 *
 * Output: task-2-canonical.json (next to this script).
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

const { resolveBuiltinPolicy } = serverRequire(
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

function constantDerived(name) {
  const cfg = factorySeedConfig(name);
  return {
    description: ROLE_BOUNDARIES[name].scopeSummary,
    mode: name === 'vteam-plan' ? 'all' : 'primary',
    permission: cfg.permission,
    tools: cfg.tools,
    bashDeny: [],
    correction: cfg.correction,
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

function reverseKeys(value) {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value).reverse())
      out[key] = reverseKeys(val);
    return out;
  }
  return value;
}

const store = (v) => JSON.parse(JSON.stringify(v));
const comparable = (r) => {
  const { serverGated: _sg, ...rest } = r;
  return rest;
};

const baseline = JSON.parse(
  readFileSync(join(HERE, 'before-agent-policies.json'), 'utf8'),
);

const roles = {};
let allPass = true;

for (const name of BUILTIN_ORDER) {
  const expected = constantDerived(name);
  const baseAgent = baseline.agents.find((a) => a.name === name);
  const baseRole = baseline.guard.roles[name];
  const baselineShape = {
    description: baseAgent.description,
    mode: baseAgent.mode,
    permission: baseAgent.permission,
    tools: baseRole.tools,
    bashDeny: baseRole.bashDeny,
    correction: baseRole.correction,
  };

  const variants = {
    plain: store(factorySeedConfig(name)),
    mysqlOrdered: store(reorderLikeMysql(factorySeedConfig(name))),
    reversed: store(reverseKeys(factorySeedConfig(name))),
  };

  const perVariant = {};
  for (const [label, config] of Object.entries(variants)) {
    const serialized = JSON.stringify(comparable(resolveBuiltinPolicy(name, config)));
    perVariant[label] = {
      config_key_order: Object.keys(config.permission),
      equals_constant: serialized === JSON.stringify(expected),
      equals_baseline: serialized === JSON.stringify(baselineShape),
    };
  }
  const pass =
    perVariant.plain.equals_constant &&
    perVariant.plain.equals_baseline &&
    perVariant.mysqlOrdered.equals_constant &&
    perVariant.mysqlOrdered.equals_baseline &&
    perVariant.reversed.equals_constant &&
    perVariant.reversed.equals_baseline;
  allPass = allPass && pass;

  // Normalization: write dropped, illegal tools dropped, bashDeny coerced to string[].
  const normalized = comparable(
    resolveBuiltinPolicy(name, {
      ...factorySeedConfig(name),
      permission: {
        write: { '*': 'allow' },
        ...factorySeedConfig(name).permission,
      },
      tools: {
        ...factorySeedConfig(name).tools,
        bogus_tool: 'whatever',
        bad_value: 42,
      },
      bashDeny: ['rm -rf /', 42, null],
    }),
  );
  const normalization = {
    write_dropped: !('write' in normalized.permission),
    illegal_tool_dropped: !('bogus_tool' in normalized.tools) && !('bad_value' in normalized.tools),
    constant_tools_preserved:
      Object.keys(normalized.tools).length === Object.keys(ROLE_BOUNDARIES[name].toolAllows).length,
    bashDeny_coerced_to_string_array:
      Array.isArray(normalized.bashDeny) && normalized.bashDeny.every((p) => typeof p === 'string'),
    bashDeny_value: normalized.bashDeny,
  };

  roles[name] = {
    pass,
    expected_permission_key_order: Object.keys(expected.permission),
    resolved_permission_key_order: Object.keys(comparable(resolveBuiltinPolicy(name, variants.mysqlOrdered)).permission),
    variants: perVariant,
    normalization,
  };
}

// Tools fallback: absent tools must never yield {}.
const fallbackProbe = {};
for (const name of BUILTIN_ORDER) {
  const cfg = factorySeedConfig(name);
  const resolved = resolveBuiltinPolicy(name, { permission: cfg.permission, correction: cfg.correction });
  fallbackProbe[name] = {
    tools_absent_falls_back_to_constant:
      JSON.stringify(resolved.tools) === JSON.stringify(ROLE_BOUNDARIES[name].toolAllows),
    tool_count: Object.keys(resolved.tools).length,
  };
}
allPass = allPass && Object.values(fallbackProbe).every((p) => p.tools_absent_falls_back_to_constant && p.tool_count > 0);

const doc = {
  _meta: {
    task: 'task-2-canonical',
    plan: 'vteam-role-behavior-abstraction',
    kind: 'canonical-emission-provenance',
    proof:
      'JSON.parse(JSON.stringify(config)) with keys reordered like a MySQL JSON column (and fully reversed) resolves byte-identically (JSON.stringify) to both the constant-derived output and the frozen baseline before-agent-policies.json',
    baseline: 'before-agent-policies.json (captured at HEAD f0b1924)',
    note: 'No DB connection opened; resolveBuiltinPolicy is pure.',
  },
  allPass,
  roles,
  tools_fallback_probe: fallbackProbe,
};

writeFileSync(join(HERE, 'task-2-canonical.json'), JSON.stringify(doc, null, 2) + '\n');
console.log('allPass:', allPass);
for (const name of BUILTIN_ORDER) {
  console.log(`  ${name}: ${roles[name].pass ? 'PASS' : 'FAIL'}`);
}
process.exitCode = allPass ? 0 : 1;
