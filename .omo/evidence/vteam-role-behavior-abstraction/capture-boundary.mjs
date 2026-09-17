/**
 * Boundary-source provenance harness (plan task 11: vteam-role-behavior-abstraction).
 *
 * Proves, WITHOUT a DB connection, that the dispatch boundary section is now driven by a
 * resolved policy `correction` (not a name-list gate) while the factory state stays
 * byte-identical:
 *   (a) for each of the 7 built-ins, `renderBoundarySection(constant correction)` equals the
 *       pre-change string captured in `before-boundary.json` (byte-for-byte);
 *   (b) the same holds for a correction round-tripped through `JSON.parse(JSON.stringify())`
 *       with keys REORDERED (simulates MySQL native JSON key ordering) — canonicalization
 *       restores the constant handoff order;
 *   (c) a CUSTOM agent whose policy returns a custom `correction` now gets a non-empty
 *       boundary section through the real `WorkerDispatcher.resolveBoundaryCorrection`
 *       (previously `''` because the name-list gate rejected it);
 *   (d) an absent correction (no policy service) for a known role falls back to the constant
 *       section; `renderBoundarySection(null/{} / empty scopeSummary)` returns `''`.
 *
 * Usage (from anywhere; server/ has ts-node):
 *   node capture-boundary.mjs
 *
 * Output: task-11-boundary.json (next to this script).
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
  canonicalizeCorrection,
  resolveConstantPolicySource,
} = serverRequire(
  join(SERVER_ROOT, 'src/execution-policies/execution-policy.service.ts'),
);
const { renderBoundarySection, WorkerDispatcher } = serverRequire(
  join(SERVER_ROOT, 'src/chat/worker-dispatcher.ts'),
);

const beforeBoundary = JSON.parse(
  readFileSync(join(HERE, 'before-boundary.json'), 'utf8'),
);
const beforeAgentPolicies = JSON.parse(
  readFileSync(join(HERE, 'before-agent-policies.json'), 'utf8'),
);

const NAMES = [
  'vteam-plan',
  'vteam-product',
  'vteam-architect',
  'vteam-developer',
  'vteam-tester',
  'vteam-project_manager',
  'vteam-librarian',
];

/** Deep-reorder every object's keys (reverse insertion order) to mimic MySQL JSON storage. */
function shuffleKeys(value) {
  if (Array.isArray(value)) return value.map(shuffleKeys);
  if (typeof value !== 'object' || value === null) return value;
  const out = {};
  for (const key of Object.keys(value).reverse()) {
    out[key] = shuffleKeys(value[key]);
  }
  return out;
}

function makeDispatcher(policyService) {
  const noop = () => {};
  return new WorkerDispatcher(
    {},
    {},
    {},
    {},
    {},
    {},
    {},
    { get: () => undefined },
    {
      onTaskCompleted: noop,
      onAgentStatus: noop,
      onSessionActivity: noop,
    },
    undefined,
    undefined,
    policyService,
  );
}

const checks = {};
let allPass = true;
const record = (name, pass, detail) => {
  checks[name] = { pass, ...detail };
  if (!pass) allPass = false;
};

// (a) factory constant correction → pre-change string, all 7 built-ins.
const constantMatches = {};
for (const name of NAMES) {
  const expected = beforeBoundary.sections[name];
  const actual = renderBoundarySection(
    resolveConstantPolicySource(name)?.config.correction,
  );
  constantMatches[name] = actual === expected;
}
record(
  'builtin_factory_correction_byte_identical',
  Object.values(constantMatches).every(Boolean),
  { perName: constantMatches },
);

// (b) MySQL-reordered correction → pre-change string (canonicalization restores order).
const reorderedMatches = {};
for (const name of NAMES) {
  const expected = beforeBoundary.sections[name];
  const raw = beforeAgentPolicies.guard.roles[name].correction;
  const shuffled = JSON.parse(JSON.stringify(shuffleKeys(raw)));
  const canonical = canonicalizeCorrection(shuffled, name);
  const actual = renderBoundarySection(canonical);
  reorderedMatches[name] = actual === expected;
}
record(
  'builtin_db_reordered_correction_byte_identical',
  Object.values(reorderedMatches).every(Boolean),
  { perName: reorderedMatches },
);

const main = async () => {
  // (c) CUSTOM agent with a policy correction → non-empty section through the dispatch resolver.
  const customCorrection = {
    scopeSummary: '自定义职责：只读检索并给出出处，不执行变更。',
    handoff: { review: 'vteam-tester', process: 'vteam-project_manager' },
    denyTemplate: '【越界拦截｜角色：{role}】',
  };
  const customPolicyService = {
    resolveByAgent: async () => ({
      policyId: 'ep_custom_demo',
      policyName: '示例策略',
      agentName: 'vteam-demo-agent',
      permission: {},
      tools: {},
      bashDeny: [],
      correction: customCorrection,
      serverGated: [],
    }),
  };
  const dispatcher = makeDispatcher(customPolicyService);
  const customResolved = await dispatcher.resolveBoundaryCorrection({
    id: 'a_demo',
    name: '示例助手',
    role: null,
    prompt: null,
    persona: null,
    agentKey: 'demo-agent',
    policyId: 'ep_custom_demo',
  });
  const customSection = renderBoundarySection(customResolved);
  const customArgs = { customCorrection, customSection };
  record(
    'custom_agent_correction_nonempty',
    customSection.length > 0 &&
      customSection.includes(customCorrection.scopeSummary) &&
      customSection.includes('review→vteam-tester'),
    customArgs,
  );

  // (d) absent policy service + known role → constant fallback; unknown role → null.
  const fallbackDispatcher = makeDispatcher(undefined);
  const fallbackResolved = await fallbackDispatcher.resolveBoundaryCorrection({
    id: 'a_product',
    name: '产品经理',
    role: 'product',
    prompt: null,
    persona: null,
    agentKey: 'product',
    policyId: null,
  });
  const fallbackSection = renderBoundarySection(fallbackResolved);
  record(
    'known_role_missing_policy_falls_back_to_constant',
    fallbackSection === beforeBoundary.sections['vteam-product'],
    { fallbackSection },
  );

  const unknownResolved = await fallbackDispatcher.resolveBoundaryCorrection({
    id: 'a_unknown',
    name: '未知',
    role: 'mystery',
    prompt: null,
    persona: null,
    agentKey: null,
    policyId: null,
  });
  record('unknown_role_no_correction_returns_empty', unknownResolved === null, {
    unknownResolved,
  });

  // (e) empty / absent correction → ''.
  record(
    'empty_correction_renders_empty',
    renderBoundarySection(null) === '' &&
      renderBoundarySection(undefined) === '' &&
      renderBoundarySection({}) === '' &&
      renderBoundarySection({ scopeSummary: '' }) === '' &&
      renderBoundarySection({ scopeSummary: 42 }) === '',
    {},
  );

  const out = {
    _meta: {
      kind: 'task-11-boundary',
      plan: 'vteam-role-behavior-abstraction',
      proves:
        'boundary section sourced from resolved policy correction; factory output byte-identical; custom agent correction now renders',
    },
    allPass,
    checks,
  };
  writeFileSync(join(HERE, 'task-11-boundary.json'), JSON.stringify(out, null, 2) + '\n');
  console.log(JSON.stringify(out, null, 2));
  if (!allPass) {
    console.error('FAIL: some checks did not pass');
    process.exit(1);
  }
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
