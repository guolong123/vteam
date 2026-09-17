/**
 * Baseline capture harness (plan task 1: vteam-role-behavior-abstraction).
 *
 * Captures, from a CLEAN tree, the pre-change serialized output of
 * `ExecutionPolicyService.buildAgentPolicies()` (constant path, empty prisma stub)
 * and the factory `ep_<role>` policy `config` shape that `prisma/seed.ts` writes
 * (source-derived from the canonical `src/common/constants/agent.constants.ts`
 * ROLE_BOUNDARIES; seed.ts carries a self-contained mirror that
 * `src/prisma/seed.spec.ts` asserts byte-identical).
 *
 * Read-only with respect to product code and DB — no prisma connection is opened.
 *
 * Usage (from anywhere; node >= 22 with ts-node installed in server/):
 *   node capture-baseline.mjs
 *   node --no-experimental-strip-types capture-baseline.mjs   # if native TS strip interferes
 *
 * Outputs (next to this script):
 *   before-agent-policies.json
 *   before-seed-policy-config.json
 */
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = resolve(HERE, '../../../server');
const serverRequire = createRequire(join(SERVER_ROOT, 'package.json'));

// --- ts-node register (CommonJS hook; tsconfig from server/) ------------------
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
// reflect-metadata must load before any @nestjs/common-decorated module is required.
serverRequire('reflect-metadata');

const { ExecutionPolicyService } = serverRequire(
  join(SERVER_ROOT, 'src/execution-policies/execution-policy.service.ts'),
);
const {
  ROLE_BOUNDARIES,
  ROLE_POLICY_DENY_TEMPLATE,
  buildEditPermission,
  buildReadPermission,
} = serverRequire(join(SERVER_ROOT, 'src/common/constants/agent.constants.ts'));

// --- 1) /agent-policies baseline (constant path, empty prisma stub) ----------
async function captureAgentPolicies() {
  const prismaStub = {
    agent: { findMany: async () => [] },
    executionPolicy: { findMany: async () => [] },
  };
  const service = new ExecutionPolicyService(prismaStub, {});
  return service.buildAgentPolicies();
}

// --- 2) seed ep_<role> config baseline (source-derived; seed.ts:893-929) -----
// Row order mirrors seed.ts ROLE_POLICY_BINDINGS / templateAgents iteration.
const ROLE_POLICY_BINDINGS = {
  product: { policyId: 'ep_product', agentName: 'vteam-product' },
  project_manager: {
    policyId: 'ep_project_manager',
    agentName: 'vteam-project_manager',
  },
  architect: { policyId: 'ep_architect', agentName: 'vteam-architect' },
  developer: { policyId: 'ep_developer', agentName: 'vteam-developer' },
  tester: { policyId: 'ep_tester', agentName: 'vteam-tester' },
  plan: { policyId: 'ep_plan', agentName: 'vteam-plan' },
  librarian: { policyId: 'ep_librarian', agentName: 'vteam-librarian' },
};

function buildSeedPolicyConfig(agentName) {
  const boundary = ROLE_BOUNDARIES[agentName];
  // seed.ts:896-902 — runtime taskEffect field wins, else vteam-plan=allow.
  const taskEffect =
    boundary.taskEffect === 'allow' || boundary.taskEffect === 'deny'
      ? boundary.taskEffect
      : agentName === 'vteam-plan'
        ? 'allow'
        : 'deny';
  return {
    permission: {
      edit: buildEditPermission(boundary.writeGlobs),
      read: buildReadPermission(),
      bash: boundary.bashEffect,
      task: taskEffect,
      ...Object.fromEntries(boundary.mcpDenies.map((tool) => [tool, 'deny'])),
    },
    correction: {
      scopeSummary: boundary.scopeSummary,
      handoff: boundary.handoffTo,
      denyTemplate: ROLE_POLICY_DENY_TEMPLATE,
    },
    tools: { ...boundary.toolAllows },
  };
}

function captureSeedPolicyConfig() {
  const policies = {};
  for (const { policyId, agentName } of Object.values(ROLE_POLICY_BINDINGS)) {
    policies[policyId] = { agentName, config: buildSeedPolicyConfig(agentName) };
  }
  return policies;
}

// --- run ----------------------------------------------------------------------
const agentPolicies = await captureAgentPolicies();
const agentNames = agentPolicies.agents.map((a) => a.name);
const roleKeys = Object.keys(agentPolicies.guard.roles);
if (agentPolicies.agents.length !== 7 || roleKeys.length !== 7) {
  throw new Error(
    `expected 7 agents + 7 guard roles, got ${agentPolicies.agents.length} + ${roleKeys.length}`,
  );
}
writeFileSync(
  join(HERE, 'before-agent-policies.json'),
  JSON.stringify(agentPolicies, null, 2) + '\n',
);

const seedPolicies = captureSeedPolicyConfig();
const seedDoc = {
  _meta: {
    kind: 'source-derived',
    derivedFrom:
      'server/prisma/seed.ts:893-929 config construction, values via canonical server/src/common/constants/agent.constants.ts ROLE_BOUNDARIES (seed.ts mirror asserted byte-identical by server/src/prisma/seed.spec.ts)',
    note: 'NOT captured from a database: MySQL JSON column reorders object keys on storage; this records the factory object-literal insertion order.',
    keyInsertionOrder: {
      permission: ['edit', 'read', 'bash', 'task', '...mcpDenies (VTEAM_MCP_TOOL_NAMES order, filtered)'],
      correction: ['scopeSummary', 'handoff', 'denyTemplate'],
      tools: 'ROLE_BOUNDARIES[agentName].toolAllows insertion order',
      policies: Object.keys(seedPolicies),
    },
  },
  policies: seedPolicies,
};
writeFileSync(
  join(HERE, 'before-seed-policy-config.json'),
  JSON.stringify(seedDoc, null, 2) + '\n',
);

console.log('agent count:', agentPolicies.agents.length);
console.log('agent names:', agentNames.join(', '));
console.log('guard role keys:', roleKeys.join(', '));
console.log('seed policy ids:', Object.keys(seedPolicies).join(', '));
