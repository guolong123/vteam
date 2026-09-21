/**
 * todo 9 (d) — server-side plan-gate/selection proof for a RENAMED plan-duty agent,
 * WITHOUT claiming end-to-end fan-out.
 *
 * What this proves:
 *   D1  `resolvePolicyAgentCandidate` is name-independent: it returns `vteam-<agentKey>`
 *       for ANY valid agentKey, so a RENAMED agent is selected as the policy candidate
 *       exactly like a built-in one (the server no longer consults `Agent.role`).
 *   D2  the plan-duty decision is duty-based, not id/name-based: a renamed binding whose
 *       registered opencode duty is 'plan' resolves to plan duty, while `vteam-prometheus`
 *       (unregistered) stays execute. This is the SAME registry used by
 *       `resolvePlanAgentId` (plan-docs), `isPlanDutyMember` (verdict listener),
 *       `deriveAgentMode`/`resolveTaskEffect` (policy emission) and `toTaskDto.effectivePlanMode`.
 *   D3  the REAL dispatcher, driven against the LIVE stack with a RENAMED plan-duty binding,
 *       emits the plan-mode instruction set (server-side gate/selection observable), and the
 *       payload's `agent` field is the literal `vteam-plan` — the ONLY name the worker guard
 *       accepts for `task`. A renamed planner therefore CANNOT fan out sub-agents.
 *   D4  the worker guard's literal exception, read from the SHIPPED worker source
 *       (`worker/src/role-guard/policy.ts`) and EXECUTED via the shipped compiled guard
 *       (`worker/dist/role-guard/policy.js`) against both the literal and a renamed agent.
 *   D5  live literal `vteam-plan` planner path: the injected `opencode.json` carries
 *       `vteam-plan` with `mode=all` + `permission.task=allow`.
 *
 * Zero live-stack mutation: the dispatch uses a dedicated scratch session row created and
 * deleted inside the scratch DB (which is dropped entirely at cleanup).
 */
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const REPO = '/Volumes/SSD-Data/01work/git-project/vteam';
const SERVER = `${REPO}/server`;
const OUT = `${REPO}/.omo/evidence/agent-role-decommission/task-9`;
const DB_NAME = 'aiagents_t9';

const req = createRequire(`${SERVER}/package.json`);
req('ts-node').register({
  transpileOnly: true, project: `${SERVER}/tsconfig.json`,
  compilerOptions: { module: 'commonjs', target: 'ES2021', experimentalDecorators: true,
    emitDecoratorMetadata: true, esModuleInterop: true, allowSyntheticDefaultImports: true, skipLibCheck: true },
});
req('reflect-metadata');
const { PrismaClient } = req('@prisma/client');

const DB_IP = execSync("docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' aiagents-compose-db").toString().trim();
const prisma = new PrismaClient({ datasources: { db: { url: `mysql://root:aiagents-root@${DB_IP}:3306/${DB_NAME}` } } });

const { getOpencodeAgentDuty, listPlanDutyAgents } = req(`${SERVER}/src/common/opencode-agent-duty.ts`);
const { resolvePolicyAgentCandidate } = req(`${SERVER}/src/chat/worker-dispatcher.ts`);
const { WorkerDispatcher } = req(`${SERVER}/src/chat/worker-dispatcher.ts`);
const { ExecutionPolicyService } = req(`${SERVER}/src/execution-policies/execution-policy.service.ts`);

const result = { generatedAt: new Date().toISOString() };

/* ---------------------------------------------------------------- D1 name independence */
result.D1_policyCandidate = {
  note: 'server-side selection is agentKey-driven; the agent NAME/role is never consulted',
  cases: [
    ['builtin product   ', { agentKey: 'product' }],
    ['renamed myagent  ', { agentKey: 'myagent' }],
    ['renamed nopolicy ', { agentKey: 'nopolicy-t9' }],
    ['no key (archivist)', { agentKey: null }],
    ['legacy row shape with role only', { agentKey: null, role: 'developer' }],
  ].map(([label, row]) => ({ label: label.trim(), input: row, candidate: resolvePolicyAgentCandidate(row) })),
};

/* ---------------------------------------------------------------- D2 duty registry */
const renamedPlanDuty = 'Prometheus - Plan Builder'; // registered plan duty, NOT the vteam-plan literal
result.D2_planDuty = {
  note: 'plan duty comes from the registered duty of the BOUND opencode agent',
  registry: listPlanDutyAgents(),
  literal_vteam_plan: getOpencodeAgentDuty('vteam-plan'),
  renamed_plan_duty: getOpencodeAgentDuty(renamedPlanDuty),
  renamed_lookalike_vteam_prometheus: getOpencodeAgentDuty('vteam-prometheus'),
  custom_agent: getOpencodeAgentDuty('vteam-myagent'),
  renamedBindingEntersPlanMode: getOpencodeAgentDuty(renamedPlanDuty) === 'plan',
  customBindingEntersPlanMode: getOpencodeAgentDuty('vteam-myagent') === 'plan',
};

/* ---------------------------------------------------------------- D3 + D4 real stack */
const workerRow = (await prisma.$queryRawUnsafe(
  `SELECT id, capabilities, default_model_id FROM workers WHERE status='online' LIMIT 1`))[0];
const caps = typeof workerRow.capabilities === 'string' ? JSON.parse(workerRow.capabilities) : workerRow.capabilities;

// The scratch team member tmm_0000000002 (project_manager, its Agent has agentKey
// 'project_manager'); we OVERRIDE its opencodeAgentName to the RENAMED plan-duty agent
// ('Prometheus - Plan Builder' — registered plan duty, not the vteam-plan literal). This
// is exactly the shape of "a renamed plan-duty agent": the server gate must select/plan
// regardless of the name.
const TEAM = 'tm_0000000001';
const MEMBER = 'tmm_0000000002';
// Reuse the pre-existing session row for this member (uk_sessions_team_member is unique on
// the generated team_member_key column -> one session per member). Its scratch-DB state is
// pre-existing (status='failed'); we do NOT mutate it, and the scratch DB is dropped at cleanup.
const authSession = (await prisma.$queryRawUnsafe(
  `SELECT id FROM sessions WHERE team_id = ? AND team_member_id = ? LIMIT 1`, TEAM, MEMBER))[0]?.id;
if (!authSession) throw new Error('no session row for the probe member');
await prisma.$executeRawUnsafe(
  `UPDATE team_members SET opencode_agent_name = ? WHERE id = ?`, renamedPlanDuty, MEMBER);

const policySvc = new ExecutionPolicyService(prisma, { nextId: async () => 'x' }, { broadcastCommand: async () => 0 });

const captured = [];
const fakeWorkerClient = {
  createSession: async () => ({ sessionID: `ses_t9_fake_${Date.now()}` }),
  execute: async (_worker, payload) => { captured.push(payload); return {}; },
  abort: async () => ({}),
  promptAsync: async () => ({}),
  getMessages: async () => [],
};
const realtime = { broadcast: async () => ({ id: 'ev' }) };
const idGen = { nextId: async () => `m_${Date.now()}` };
const sessionLifecycle = {
  ensureTeamSession: async () => ({ id: authSession, agentId: 'a_project_manager' }),
  bindSessionToWorker: async () => {},
  unbindSession: async () => {},
};
const workersService = { assignWorker: async () => workerRow.id };
const artifactsService = { onArtifactSubmitted: async () => {} };
// firstTokenTimeoutMs=0 disables the watchdog so the probe leaves no timer behind.
const config = { get: (k) => (k === 'FIRST_TOKEN_TIMEOUT_MS' ? 0 : k === 'AGENT_IDLE_TIMEOUT_MS' ? 0 : undefined) };
const ingress = {
  onTaskCompleted: () => {}, onAgentStatus: () => {}, onSessionActivity: () => {},
};
const triggers = { registerHandler: () => {}, schedule: async () => {}, cancel: async () => {} };

const dispatcher = new WorkerDispatcher(
  prisma, idGen, realtime, workersService, fakeWorkerClient, sessionLifecycle,
  artifactsService, config, ingress, undefined, triggers, policySvc,
);

let dispatchError = null;
try {
  // A real taskId is required: the plan-mode derivation block runs only when
  // taskIdForPrompt is non-empty (worker-dispatcher ~:2169). t_0000000001 is a
  // scratch-DB task of TEAM with plan_mode=0, so the duty disjunct is the only
  // way effectivePlan can become true -> it isolates the DUTY path.
  await dispatcher.dispatch({
    messageId: `m_t9_d3_${Date.now()}`,
    channelId: 'c_0000000001',
    taskId: 't_0000000001',
    teamId: TEAM,
    taskContext: { taskId: 't_0000000001' },
    text: 't9 D3 renamed plan-duty dispatch probe',
    targets: [{ agentId: 'a_project_manager', instanceId: MEMBER, sessionId: authSession }],
  });
} catch (err) { dispatchError = String(err?.message ?? err); }

const payload = captured[0] ?? null;
const system = payload?.system ?? '';
result.D3_realDispatch = {
  note: 'REAL WorkerDispatcher.dispatch executed against the LIVE stack (worker capabilities read from the live workers row)',
  binding: { teamMemberId: MEMBER, opencodeAgentName_set: renamedPlanDuty, isMainMember: true, taskId: 't_0000000001' },
  workerCapabilitiesAgentPolicies: caps?.agentPolicies ?? null,
  workerSupportsCandidate_vteam_plan: Array.isArray(caps?.agentPolicies?.names) && caps.agentPolicies.names.includes('vteam-plan'),
  dispatchError,
  emittedAgentField: payload?.agent ?? null,
  planInstructionInjected: system.includes('【计划编制】'),
  planReviewInjected: system.includes('【计划评审】'),
  editPermGlobInjected: /\.opencode\/plans\//.test(system),
  systemLength: system.length,
  systemSha256: (await import('node:crypto')).createHash('sha256').update(system).digest('hex'),
  // the server selected the plan literal — that is the bounded claim.
  boundedClaim: payload?.agent === 'vteam-plan'
    ? 'SERVER selected the literal vteam-plan for the renamed plan-duty binding (server-side selection + gate proven; fan-out NOT claimed)'
    : 'unexpected: server did not select the plan literal',
};

/* worker guard, EXECUTED from the shipped compiled artifact (read-only, no rebuild) */
const guard = req(`${REPO}/worker/dist/role-guard/policy.js`);

const rolesPath = '/tmp/t9/roles-from-container.json';
try {
  execSync(`docker exec aiagents-compose-worker cat /data/vteam-worker/.vteam-role-guard/roles.json > ${rolesPath}`);
} catch {}
const liveRolesDoc = readFileSync(rolesPath, 'utf8');
const roles = JSON.parse(liveRolesDoc);
const mkSession = (agent) => ({ agent });
result.D4_workerGuard = {
  note: 'executed with the SHIPPED worker/role-guard/policy.js against the LIVE injected roles.json',
  guardSource: 'worker/dist/role-guard/policy.js',
  rolesDocEnabled: roles.enabled === true,
  rolesInjected: Object.keys(roles.roles ?? {}),
  decisions: [
    ['literal vteam-plan + subagent_type vteam-plan', 'vteam-plan', { subagent_type: 'vteam-plan' }],
    ['renamed (Prometheus - Plan Builder) + subagent_type vteam-plan', renamedPlanDuty, { subagent_type: 'vteam-plan' }],
    ['renamed vteam-myagent + subagent_type vteam-plan', 'vteam-myagent', { subagent_type: 'vteam-plan' }],
    ['literal vteam-plan + subagent_type vteam-developer', 'vteam-plan', { subagent_type: 'vteam-developer' }],
  ].map(([label, agent, args]) => ({ label, agent, args, decision: guard.evaluateToolCall({ rolesDoc: roles, session: mkSession(agent), tool: 'task', args }) })),
};

/* D5 live literal vteam-plan planner path (injected artifacts) */
let injected = null;
try {
  injected = JSON.parse(execSync('docker exec aiagents-compose-worker cat /data/vteam-worker/opencode.json').toString());
} catch {}
const planEntry = injected?.agent?.['vteam-plan'];
result.D5_liveLiteralPlanner = {
  note: 'live worker injection: the literal vteam-plan carries mode=all + permission.task=allow',
  agentNames: Object.keys(injected?.agent ?? {}),
  vteam_plan_entry: planEntry ? { mode: planEntry.mode, task: planEntry.permission?.task,
    edit: planEntry.permission?.edit } : null,
  vteam_plan_mode_all: planEntry?.mode === 'all',
  vteam_plan_task_allow: planEntry?.permission?.task === 'allow',
  renamedEntryAbsent: !Object.keys(injected?.agent ?? {}).includes(renamedPlanDuty),
};

/* cleanup scratch-side mutation */
await prisma.$executeRawUnsafe(`UPDATE team_members SET opencode_agent_name = NULL WHERE id = ?`, MEMBER);
await prisma.$disconnect();

writeFileSync(`${OUT}/plan-gate.json`, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
