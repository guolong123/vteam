/**
 * Unified-fallback provenance harness (plan task 5: vteam-role-behavior-abstraction).
 *
 * Proves, WITHOUT a DB connection, the two checks the task acceptance criteria name:
 *   (a) a missing `ep_<role>` row yields the constant-derived policy (NOT null)
 *       through BOTH resolve paths:
 *         - `ExecutionPolicyService.resolveByAgent` / `resolveManyByAgents`;
 *         - `AgentsService.resolveTemplateSource` (the create/clone provisioning source);
 *   (b) a custom agent provisioned by `AgentsService.create` always gets its OWN
 *       `type='custom'` policy id (never the `ep_<role>` template row).
 *
 * Usage (from anywhere; server/ has ts-node):
 *   node capture-fallback.mjs
 *
 * Output: task-5-fallback.json (next to this script).
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
  resolveConstantPolicySource,
} = serverRequire(
  join(SERVER_ROOT, 'src/execution-policies/execution-policy.service.ts'),
);
const { AgentsService } = serverRequire(
  join(SERVER_ROOT, 'src/agents/agents.service.ts'),
);
const { ROLE_BOUNDARIES, ROLE_BASH_DENY_PATTERNS } = serverRequire(
  join(SERVER_ROOT, 'src/common/constants/agent.constants.ts'),
);

const checks = {};
let allPass = true;
const record = (key, pass, detail) => {
  checks[key] = { pass, ...detail };
  allPass = allPass && pass;
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------------------------------------------------------------------------
// Path A: ExecutionPolicyService.resolveByAgent / resolveManyByAgents
// ---------------------------------------------------------------------------
{
  const missingRowService = (policy) =>
    new ExecutionPolicyService(
      {
        executionPolicy: {
          findUnique: () => Promise.resolve(policy),
          findMany: () => Promise.resolve(policy === null ? [] : [policy]),
        },
      },
      {},
    );

  const single = await missingRowService(null).resolveByAgent({
    policyId: 'ep_product',
    role: 'product',
  });
  const expectedProduct = resolveConstantPolicySource('vteam-product');
  const productOk =
    single !== null &&
    single.policyId === 'ep_product' &&
    single.agentName === 'vteam-product' &&
    eq(single.tools, ROLE_BOUNDARIES['vteam-product'].toolAllows) &&
    Object.keys(single.tools).length > 0 &&
    eq(single.permission, expectedProduct.config.permission) &&
    eq(single.correction, expectedProduct.config.correction) &&
    eq(single.bashDeny, [...ROLE_BASH_DENY_PATTERNS]);
  record('resolveByAgent_missing_row_constant_not_null', productOk, {
    returned_null: single === null,
    policyId: single?.policyId ?? null,
    agentName: single?.agentName ?? null,
    tool_count: single ? Object.keys(single.tools).length : null,
    tools_equal_constant:
      single !== null &&
      eq(single.tools, ROLE_BOUNDARIES['vteam-product'].toolAllows),
  });

  const list = await missingRowService(null).resolveManyByAgents([
    { policyId: 'ep_plan', role: 'plan' },
    { policyId: 'ep_librarian', role: 'librarian' },
  ]);
  const plan = list[0];
  const librarian = list[1];
  record(
    'resolveManyByAgents_missing_rows_constant_not_null',
    plan !== null &&
      librarian !== null &&
      plan.permission.task === 'allow' &&
      eq(plan.tools, ROLE_BOUNDARIES['vteam-plan'].toolAllows) &&
      eq(librarian.tools, ROLE_BOUNDARIES['vteam-librarian'].toolAllows),
    {
      plan_null: plan === null,
      librarian_null: librarian === null,
      plan_task: plan?.permission?.task ?? null,
    },
  );

  // Row-present must still win over the constant fallback for the DB-sourced fields
  // (permission/correction/policyName). `tools` for a built-in name is still resolved
  // by guardForAgent from constants here — Todo 4 owns flipping that.
  const dbTools = { vteam_group_post: 'deny', vteam_memory_search: 'ask' };
  const present = await missingRowService({
    id: 'ep_product',
    name: 'db-product',
    config: {
      permission: { edit: { '*': 'deny' }, task: 'deny' },
      correction: { scopeSummary: 'db' },
      tools: dbTools,
    },
  }).resolveByAgent({ policyId: 'ep_product', role: 'product' });
  record(
    'resolveByAgent_present_row_wins',
    present?.policyName === 'db-product' &&
      eq(present?.permission, { edit: { '*': 'deny' }, task: 'deny' }) &&
      eq(present?.correction, { scopeSummary: 'db' }),
    {
      policyName: present?.policyName ?? null,
      permission: present?.permission ?? null,
      correction: present?.correction ?? null,
    },
  );
}

// ---------------------------------------------------------------------------
// Path B: AgentsService.resolveTemplateSource (private, runtime-accessible)
// ---------------------------------------------------------------------------
{
  const tx = {
    executionPolicy: {
      findUnique: () => Promise.resolve(null),
    },
  };
  const stubRepo = {
    onModuleInit: () => Promise.resolve(),
    executionPolicy: { findUnique: () => Promise.resolve(null) },
  };
  const agents = new AgentsService(
    stubRepo,
    {},
    {},
    {},
    {},
    stubRepo,
  );

  const source = await agents.resolveTemplateSource(tx, 'developer');
  const expected = resolveConstantPolicySource('vteam-developer');
  record(
    'resolveTemplateSource_missing_row_constant_not_null',
    source !== null &&
      eq(source.config, expected.config) &&
      source.description === expected.description,
    {
      returned_null: source === null,
      description: source?.description ?? null,
      tools_equal_constant:
        source !== null &&
        eq(source.config.tools, ROLE_BOUNDARIES['vteam-developer'].toolAllows),
      tool_count: source ? Object.keys(source.config.tools).length : null,
    },
  );

  // Unknown role (non-builtin) still yields null (caller builds the deny skeleton).
  const unknown = await agents.resolveTemplateSource(tx, 'analyst');
  record('resolveTemplateSource_unknown_role_null', unknown === null, {
    returned_null: unknown === null,
  });
}

// ---------------------------------------------------------------------------
// Check (b): custom-agent provisioning never binds the `ep_<role>` template row
// ---------------------------------------------------------------------------
{
  const createdPolicies = [];
  let createdAgentData = null;
  const prisma = {
    executionPolicy: {
      findUnique: () => Promise.resolve(null),
      create: (args) => {
        createdPolicies.push(args.data);
        return Promise.resolve(args.data);
      },
    },
    agent: {
      create: (args) => {
        createdAgentData = args.data;
        return Promise.resolve({ ...args.data, skills: [] });
      },
    },
    agentSkill: { create: () => Promise.resolve({}) },
    $transaction: (cb) => cb(prisma),
  };
  const idGen = {
    nextId: async (prefix) => `${prefix}_0000000001`,
  };
  const executionPolicyService = {
    resolveManyByAgents: () => Promise.resolve([null]),
  };
  const agents = new AgentsService(
    prisma,
    idGen,
    {},
    {},
    {},
    executionPolicyService,
  );

  const result = await agents.create('u_admin', {
    name: '外包开发者',
    type: 'custom',
    agentKey: 'outsourced-dev',
    role: 'developer',
  });

  const customPolicy = createdPolicies[0];
  record(
    'custom_agent_binds_own_custom_policy_never_template',
    createdPolicies.length === 1 &&
      customPolicy.type === 'custom' &&
      customPolicy.id !== 'ep_developer' &&
      createdAgentData.policyId === customPolicy.id &&
      createdAgentData.policyId !== 'ep_developer' &&
      result.policyId !== 'ep_developer',
    {
      created_policy_count: createdPolicies.length,
      created_policy_type: customPolicy?.type ?? null,
      created_policy_id: customPolicy?.id ?? null,
      bound_policy_id: createdAgentData?.policyId ?? null,
      template_id: 'ep_developer',
      bound_is_template: createdAgentData?.policyId === 'ep_developer',
    },
  );
}

const doc = {
  _meta: {
    task: 'task-5-fallback',
    plan: 'vteam-role-behavior-abstraction',
    kind: 'unified-fallback-provenance',
    proof:
      'A missing ep_<role> row yields the constant-derived policy (never null) through BOTH resolveByAgent/resolveManyByAgents and AgentsService.resolveTemplateSource; a row present still wins; and a custom agent provisioned by create() always receives its own type=custom policy id, never the ep_<role> template row.',
    baseline: 'before-agent-policies.json (captured at HEAD f0b1924)',
    note: 'No DB connection opened; prisma is stubbed in-process.',
  },
  allPass,
  checks,
};

writeFileSync(
  join(HERE, 'task-5-fallback.json'),
  JSON.stringify(doc, null, 2) + '\n',
);
console.log('allPass:', allPass);
for (const [key, value] of Object.entries(checks)) {
  console.log(`  ${key}: ${value.pass ? 'PASS' : 'FAIL'}`);
}
process.exitCode = allPass ? 0 : 1;
