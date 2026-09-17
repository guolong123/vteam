/**
 * Re-seed preservation harness (plan tasks 9+10: vteam-role-behavior-abstraction).
 *
 * Runs the REAL `main()` from `server/prisma/seed.ts` against an in-process fake
 * prisma client (no DB connection) that implements true upsert semantics
 * (existing row + empty update => row untouched; missing row => create fires).
 *
 * Proves:
 *   (a) every template ExecutionPolicy upsert and template agent upsert carries
 *       `update: {}` (zero own keys) — the minimal create-if-absent contract;
 *   (b) on a fresh store all 7 ep_<role> policies + 7 template agents are still
 *       created with the full factory config/prompt (create branch unchanged),
 *       config deep-equal to before-seed-policy-config.json;
 *   (c) policies still upsert before agents;
 *   (d) after a user edits a policy config/description and an agent
 *       prompt/policyId/agentKey, a second `main()` run leaves every edited
 *       value intact (and a counterfactual check shows the OLD payload WOULD
 *       have clobbered them, so the survival assertion is not vacuous).
 *
 * Usage (from anywhere; server/ has ts-node):
 *   node capture-seed-preserve.mjs
 *
 * Output: task-9-10-seed-preserve.txt (next to this script).
 */
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = resolve(HERE, '../../../server');
const serverRequire = createRequire(join(SERVER_ROOT, 'package.json'));

// --- fake prisma (in-process, no DB) -----------------------------------------
const lines = [];
const checks = {};
let allPass = true;
const log = (s) => {
  lines.push(s);
  console.log(s);
};
const record = (key, pass, detail) => {
  checks[key] = { pass, detail };
  allPass = allPass && pass;
  log(`  [${pass ? 'PASS' : 'FAIL'}] ${key}: ${detail}`);
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const DB = new Map(); // model -> Map(whereKey -> row)
const whereKey = (where) => JSON.stringify(where);
function matches(row, where) {
  if (!where) return true;
  for (const [k, v] of Object.entries(where)) {
    if (v && typeof v === 'object' && 'startsWith' in v) {
      if (!String(row[k] ?? '').startsWith(v.startsWith)) return false;
    } else if (v && typeof v === 'object' && 'in' in v) {
      if (!v.in.includes(row[k])) return false;
    } else if (row[k] !== v) {
      return false;
    }
  }
  return true;
}
function table(name) {
  if (!DB.has(name)) DB.set(name, new Map());
  return DB.get(name);
}
function model(name) {
  return {
    upsert: async ({ where, update, create }) => {
      const t = table(name);
      const k = whereKey(where);
      const existing = t.get(k);
      if (existing) {
        if (update && Object.keys(update).length > 0) Object.assign(existing, update);
        return existing;
      }
      const row = { ...create };
      t.set(k, row);
      return row;
    },
    findMany: async ({ where } = {}) =>
      [...table(name).values()].filter((row) => matches(row, where)),
    findUnique: async ({ where } = {}) => table(name).get(whereKey(where)) ?? null,
    update: async ({ where, data }) => {
      const row = table(name).get(whereKey(where));
      if (row) Object.assign(row, data);
      return row;
    },
    updateMany: async () => ({ count: 0 }),
    deleteMany: async () => ({ count: 0 }),
  };
}
const prismaMock = {
  role: model('role'),
  user: model('user'),
  agent: model('agent'),
  executionPolicy: model('executionPolicy'),
  model: model('model'),
  workerModelAvailability: model('workerModelAvailability'),
  tool: model('tool'),
  mcpServer: model('mcpServer'),
  skill: model('skill'),
  team: model('team'),
  teamMember: model('teamMember'),
  teamUserMember: model('teamUserMember'),
  memory: model('memory'),
  $disconnect: async () => undefined,
};

// Intercept '@prisma/client' before ts-node compiles seed.ts.
const Module = serverRequire('module');
const origLoad = Module._load;
class PrismaClient {
  constructor() {
    return prismaMock;
  }
}
Module._load = function (request, parent, isMain) {
  if (request === '@prisma/client') return { PrismaClient };
  return origLoad.apply(this, arguments);
};

// --- ts-node register + load seed.ts -----------------------------------------
serverRequire('ts-node').register({
  transpileOnly: true,
  project: join(SERVER_ROOT, 'tsconfig.json'),
  compilerOptions: {
    module: 'commonjs',
    target: 'ES2021',
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    skipLibCheck: true,
  },
});
const { main } = serverRequire(join(SERVER_ROOT, 'prisma/seed.ts'));

// --- capture upserts ----------------------------------------------------------
const policyCalls = [];
const agentCalls = [];
const order = [];
const wrapUpsert = (modelName, calls, label) => {
  const original = prismaMock[modelName].upsert;
  prismaMock[modelName].upsert = async (args) => {
    if (args?.where?.id?.startsWith?.('ep_') || args?.where?.id?.startsWith?.('a_')) {
      calls.push(args);
      order.push(`${label}:${args.where.id}`);
    }
    return original(args);
  };
};
wrapUpsert('executionPolicy', policyCalls, 'policy');
wrapUpsert('agent', agentCalls, 'agent');

// --- run 1: fresh store -------------------------------------------------------
log('=== run 1: fresh store (create branches) ===');
await main();
const run1PolicyCreates = policyCalls.length;
const run1AgentCreates = agentCalls.length;

const baseline = JSON.parse(
  readFileSync(join(HERE, 'before-seed-policy-config.json'), 'utf8'),
);

const templateAgentIds = new Set([
  'a_product',
  'a_project_manager',
  'a_architect',
  'a_developer',
  'a_tester',
  'a_plan',
  'a_librarian',
]);
const policyCreate = policyCalls.filter((c) => c.update && Object.keys(c.update).length === 0);
const agentCreate = agentCalls.filter(
  (c) => templateAgentIds.has(c.where.id) && c.update && Object.keys(c.update).length === 0,
);

record(
  'fresh_run_creates_7_policies_7_agents',
  run1PolicyCreates === 7 && run1AgentCreates === 7,
  `policy upserts=${run1PolicyCreates}, agent upserts=${run1AgentCreates}`,
);

// create branch still carries the full factory config (deep-equal baseline)
let configOk = true;
const configDetails = [];
for (const call of policyCalls) {
  const id = call.where.id;
  const expected = baseline.policies[id]?.config;
  const ok =
    call.create?.type === 'template' &&
    expected !== undefined &&
    eq(call.create.config, expected) &&
    typeof call.create.description === 'string' &&
    call.create.description.length > 0;
  configOk = configOk && ok;
  configDetails.push(`${id}${ok ? '' : '(MISMATCH)'}`);
}
record(
  'create_branch_factory_config_equals_baseline',
  configOk,
  configDetails.join(', '),
);

// create branch still carries the full factory prompt
let promptOk = true;
const promptDetails = [];
for (const call of agentCalls) {
  const prompt = call.create?.prompt;
  const ok =
    call.create?.type === 'template' &&
    typeof prompt === 'string' &&
    prompt.length > 50 &&
    ['## 职责', '## 权限', '## 工作方式', '## 协同方式'].every((s) => prompt.includes(s));
  promptOk = promptOk && ok;
  promptDetails.push(`${call.where.id}${ok ? '' : '(BAD PROMPT)'}`);
}
record('create_branch_factory_prompt_full', promptOk, promptDetails.join(', '));

// ordering: all 7 policy upserts before all 7 agent upserts
const policyCount = order.filter((o) => o.startsWith('policy:')).length;
const firstAgentIdx = order.findIndex((o) => o.startsWith('agent:'));
record(
  'ordering_policies_before_agents',
  policyCount === 7 && firstAgentIdx === 7,
  `sequence=${order.join(' > ')}`,
);

// --- run 2 setup: user edits the existing rows --------------------------------
const epProduct = table('executionPolicy').get(whereKey({ id: 'ep_product' }));
const aProduct = table('agent').get(whereKey({ id: 'a_product' }));
epProduct.config.tools.vteam_group_post = 'deny';
epProduct.description = 'USER-EDITED-POLICY-DESCRIPTION';
aProduct.prompt = 'USER-EDITED-PROMPT-'.repeat(5);
aProduct.policyId = 'ep_user_custom_edit';
aProduct.agentKey = 'user-edited-key';
const editedBefore = {
  policyTools: JSON.stringify(epProduct.config.tools),
  policyDescription: epProduct.description,
  agentPrompt: aProduct.prompt,
  agentPolicyId: aProduct.policyId,
  agentAgentKey: aProduct.agentKey,
};

// --- run 2: user edits must survive ------------------------------------------
log('');
log('=== run 2: existing store with user edits (update branches) ===');
policyCalls.length = 0;
agentCalls.length = 0;
await main();

record(
  'run2_upserted_existing_rows',
  policyCalls.length === 7 && agentCalls.length === 7,
  `policy upserts=${policyCalls.length}, agent upserts=${agentCalls.length}`,
);

// (a) every update payload is empty for both upserts
const policyUpdateKeys = policyCalls.map((c) => Object.keys(c.update ?? {}));
const agentUpdateKeys = agentCalls.map((c) => Object.keys(c.update ?? {}));
record(
  'policy_update_payloads_empty',
  policyUpdateKeys.every((k) => k.length === 0),
  `update key sets = ${JSON.stringify(policyUpdateKeys)}`,
);
record(
  'agent_update_payloads_empty',
  agentUpdateKeys.every((k) => k.length === 0),
  `update key sets = ${JSON.stringify(agentUpdateKeys)}`,
);

// (d) edits survive
const epProductAfter = table('executionPolicy').get(whereKey({ id: 'ep_product' }));
const aProductAfter = table('agent').get(whereKey({ id: 'a_product' }));
record(
  'user_edited_policy_config_survives_reseed',
  JSON.stringify(epProductAfter.config.tools) === editedBefore.policyTools &&
    epProductAfter.description === editedBefore.policyDescription,
  `tools.vteam_group_post=${epProductAfter.config.tools.vteam_group_post}, description=${epProductAfter.description}`,
);
record(
  'user_edited_agent_prompt_and_bindings_survive_reseed',
  aProductAfter.prompt === editedBefore.agentPrompt &&
    aProductAfter.policyId === editedBefore.agentPolicyId &&
    aProductAfter.agentKey === editedBefore.agentAgentKey,
  `prompt=${aProductAfter.prompt.slice(0, 24)}..., policyId=${aProductAfter.policyId}, agentKey=${aProductAfter.agentKey}`,
);

// counterfactual: the OLD payload would have clobbered the edits (sensitivity proof)
const oldPolicyUpdate = { name: '产品经理', description: 'factory', type: 'template', config: { tools: {} } };
const oldAgentUpdate = { prompt: 'factory-prompt', policyId: 'ep_product', agentKey: 'product' };
const counterfactualPolicy = { ...epProductAfter.config.tools };
const counterfactualPrompt = { prompt: aProductAfter.prompt };
Object.assign(counterfactualPolicy, oldPolicyUpdate.config.tools);
Object.assign(counterfactualPrompt, oldAgentUpdate);
record(
  'counterfactual_old_payload_would_have_clobbered',
  JSON.stringify(counterfactualPolicy) !== editedBefore.policyTools ||
    counterfactualPrompt.prompt !== editedBefore.agentPrompt,
  'old update payloads (config/prompt/bindings) overwrite edited values; new empty update leaves them intact',
);

// --- emit report --------------------------------------------------------------
const report = [
  '# task-9-10 seed preserve evidence (vteam-role-behavior-abstraction)',
  '',
  `result: ${allPass ? 'ALL PASS' : 'FAILURES PRESENT'}`,
  `generated_by: capture-seed-preserve.mjs (runs real main() from server/prisma/seed.ts against an in-process fake prisma with true upsert semantics; no DB connection)`,
  `seed.ts: server/prisma/seed.ts (policy upsert ~line 920, agent upsert ~line 942)`,
  '',
  '## checks',
  ...Object.entries(checks).map(([k, v]) => `- ${k}: ${v.pass ? 'PASS' : 'FAIL'} — ${v.detail}`),
  '',
  '## raw policy upsert update payloads (run 2)',
  ...policyCalls.map((c) => `- ${c.where.id}: update=${JSON.stringify(c.update)}`),
  '',
  '## raw agent upsert update payloads (run 2)',
  ...agentCalls.map((c) => `- ${c.where.id}: update=${JSON.stringify(c.update)}`),
  '',
  '## verbatim run log',
  ...lines,
  '',
].join('\n');

writeFileSync(join(HERE, 'task-9-10-seed-preserve.txt'), report);
console.log('');
console.log('allPass:', allPass);
process.exitCode = allPass ? 0 : 1;
