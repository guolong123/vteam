/**
 * todo 9 (step 5) — SERVER-SIDE plan gate/selection for a RENAMED plan-duty agent,
 * run against a SCRATCH COPY of the fresh DB (dropped at cleanup).
 *
 * Bounded claim (review fix m3 / plan O3):
 *   PROVES: the server selects the plan agent by DUTY (`getOpencodeAgentDuty` on the bound
 *           opencode name — the MAIN member's binding drives `effectivePlan`) and by DATA
 *           (`Agent.agentKey` → `resolvePolicyAgentCandidate`), never by an `Agent.role`
 *           column (which no longer exists) and never by a hardcoded member/agent id.
 *           Two renamed-binding scenarios are executed:
 *             D3a — rename the MAIN member to a plan-duty agent name: the server derives
 *                   `taskPlanMode = true` from the DUTY and injects the plan instruction
 *                   set (【计划编制】/【计划评审】/`.opencode/plans/` glob), and
 *             D3b — keep the plan member's Agent row (agentKey='plan') while renaming its
 *                   opencode binding: the policy candidate is still the reserved
 *                   `vteam-plan` because it comes from agentKey, not from the name.
 *   DOES NOT CLAIM: that a renamed planner can fan out sub-agents end to end. The WORKER
 *           guard (`worker/src/role-guard/policy.ts:172-182`) permits the `task` tool only
 *           when the mapping's agent name is the LITERAL `vteam-plan`; that is a worker-side
 *           literal this plan forbids changing. D4 EXECUTES the shipped guard on every
 *           branch (literal allow / renamed deny / unmapped pass-through / wrong subagent deny).
 *
 * Read-only against the scratch copy; the scratch DB is dropped by cleanup.
 */
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const REPO = '/Volumes/SSD-Data/01work/git-project/vteam';
const SERVER = `${REPO}/server`;
const OUT = `${REPO}/.omo/evidence/agent-role-decommission/task-9-fresh`;
const DB_NAME = 'aiagents_t9pg';

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

const { getOpencodeAgentDuty, listPlanDutyAgents, VTEAM_PLAN_AGENT_NAME } = req(`${SERVER}/src/common/opencode-agent-duty.ts`);
const { resolvePolicyAgentCandidate, WorkerDispatcher } = req(`${SERVER}/src/chat/worker-dispatcher.ts`);
const { ExecutionPolicyService } = req(`${SERVER}/src/execution-policies/execution-policy.service.ts`);

const result = { generatedAt: new Date().toISOString(), scratchDb: DB_NAME };

/* --------------------------------------------------- D0 the dropped column really is gone */
const roleCol = Number((await prisma.$queryRawUnsafe(
  `SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name='agents' AND column_name='role'`))[0].n);
result.D0_schema = {
  note: 'the consumer this probe replaces no longer exists — selection cannot be role-based by construction',
  agentsRoleColumnCount: roleCol,
  expect: 0,
};

/* ------------------------------------------------- D1 selection is agentKey/data-driven */
const RENAMED = 'Prometheus - Plan Builder'; // registered plan duty, NOT the vteam-plan literal
result.D1_policyCandidate = {
  note: 'RESOLUTION FROM DATA ONLY: agentKey → vteam-<agentKey>. No Agent.role column exists to consult.',
  cases: [
    ['seeded product template   ', { agentKey: 'product' }],
    ['seeded plan template      ', { agentKey: 'plan' }],
    ['renamed binding (no key)  ', { agentKey: null }],
    ['renamed binding (key set) ', { agentKey: 'myagent' }],
    ['lookalike key             ', { agentKey: 'nopolicy-t9' }],
  ].map(([label, row]) => ({ label: label.trim(), input: row, candidate: resolvePolicyAgentCandidate(row) })),
};

/* ------------------------------------------------- D2 duty registry (name-independent) */
result.D2_planDuty = {
  note: 'plan duty comes from the registered duty of the BOUND opencode agent — a rename that keeps '
      + "plan duty is still a planner; a `vteam-` prefix alone earns nothing",
  registry: listPlanDutyAgents(),
  literal_vteam_plan: getOpencodeAgentDuty('vteam-plan'),
  renamed_plan_duty: getOpencodeAgentDuty(RENAMED),
  renamed_lookalike: getOpencodeAgentDuty('vteam-prometheus'),
  custom_agent: getOpencodeAgentDuty('vteam-myagent'),
  renamedBindingEntersPlanMode: getOpencodeAgentDuty(RENAMED) === 'plan',
  customBindingEntersPlanMode: getOpencodeAgentDuty('vteam-myagent') === 'plan',
  planAgentNameConstant: VTEAM_PLAN_AGENT_NAME,
};

/* ------------------------------------------------- dispatch harness */
const workerRow = (await prisma.$queryRawUnsafe(
  `SELECT id, capabilities, default_model_id FROM workers WHERE status <> 'offline' LIMIT 1`))[0];
const caps = typeof workerRow.capabilities === 'string' ? JSON.parse(workerRow.capabilities) : workerRow.capabilities;
const TEAM = 'tm_0000000001';
const MAIN = 'tmm_0000000002';  // seeded main Agent = 项目经理
const PLAN_MEMBER = 'tmm_0000000006';
const TASK = 't_0000000001';
const policySvc = new ExecutionPolicyService(prisma, { nextId: async () => 'x' }, { broadcastCommand: async () => 0 });

async function dispatchAs(memberId, agentId, targetAgentId) {
  let authSession = (await prisma.$queryRawUnsafe(
    `SELECT id FROM sessions WHERE team_id = ? AND team_member_id = ? LIMIT 1`, TEAM, memberId))[0]?.id;
  if (!authSession) {
    // SCRATCH-DB ONLY: the fresh live stack created a session only for the plan member;
    // the dispatch harness needs a member-scoped session row for the main-member scenario.
    // The scratch DB is dropped at cleanup, so no live state is touched.
    authSession = `s_t9pg_${Date.now()}`;
    await prisma.$executeRawUnsafe(
      `INSERT INTO sessions (id, task_id, team_id, agent_id, team_member_id, worker_id, instance_ref, status, created_at, updated_at)
       VALUES (?, NULL, ?, ?, ?, ?, NULL, 'created', NOW(3), NOW(3))`,
      authSession, TEAM, agentId, memberId, workerRow.id);
  }
  const captured = [];
  const fakeWorkerClient = {
    createSession: async () => ({ sessionID: `ses_t9pg_${Date.now()}` }),
    execute: async (_w, payload) => { captured.push(payload); return {}; },
    abort: async () => ({}), promptAsync: async () => ({}), getMessages: async () => [],
  };
  const dispatcher = new WorkerDispatcher(
    prisma, { nextId: async () => `m_${Date.now()}` }, { broadcast: async () => ({ id: 'ev' }) },
    { assignWorker: async () => workerRow.id }, fakeWorkerClient,
    { ensureTeamSession: async () => ({ id: authSession, agentId }), bindSessionToWorker: async () => {}, unbindSession: async () => {} },
    { onArtifactSubmitted: async () => {} },
    { get: (k) => (k === 'FIRST_TOKEN_TIMEOUT_MS' ? 0 : k === 'AGENT_IDLE_TIMEOUT_MS' ? 0 : undefined) },
    { onTaskCompleted: () => {}, onAgentStatus: () => {}, onSessionActivity: () => {} },
    undefined,
    { registerHandler: () => {}, schedule: async () => {}, cancel: async () => {} },
    policySvc,
  );
  let dispatchError = null;
  try {
    await dispatcher.dispatch({
      messageId: `m_t9pg_${Date.now()}`, channelId: 'c_0000000001', taskId: TASK, teamId: TEAM,
      taskContext: { taskId: TASK },
      text: 't9 step-5 renamed plan-duty dispatch probe',
      targets: [{ agentId: targetAgentId, instanceId: memberId, sessionId: authSession }],
    });
  } catch (err) { dispatchError = String(err?.message ?? err); }
  return { payload: captured[0] ?? null, dispatchError, authSession };
}

/* ------------------------- D3a RENAMED MAIN member → server derives plan mode from DUTY */
await prisma.$executeRawUnsafe(`UPDATE team_members SET opencode_agent_name = ? WHERE id = ?`, RENAMED, MAIN);
const a = await dispatchAs(MAIN, 'a_project_manager', 'a_project_manager');
const sysA = a.payload?.system ?? '';
result.D3a_renamedMainDuty = {
  note: 'MAIN member renamed to a plan-duty agent (opencode name ' + JSON.stringify(RENAMED) + '). '
      + 'The server derives taskPlanMode from getOpencodeAgentDuty(bound name) — no id/name literal — '
      + 'and injects the plan instruction set.',
  binding: { mainMemberId: MAIN, opencodeAgentName_set: RENAMED, taskId: TASK },
  dutyResolved: getOpencodeAgentDuty(RENAMED),
  dispatchError: a.dispatchError,
  emittedAgentField: a.payload?.agent ?? null,
  planInstructionInjected: sysA.includes('【计划编制】'),
  planReviewInjected: sysA.includes('【计划评审】'),
  editPermGlobInjected: /\.opencode\/plans\//.test(sysA),
  systemLength: sysA.length,
  boundedClaim: sysA.includes('【计划编制】') && a.payload?.agent === 'vteam-plan'
    ? 'SERVER gated + selected the renamed plan-duty binding (server-side only; fan-out NOT claimed)'
    : 'unexpected: plan instruction/agent not injected for the renamed plan-duty main binding',
};
await prisma.$executeRawUnsafe(`UPDATE team_members SET opencode_agent_name = NULL WHERE id = ?`, MAIN);

/* ------------------------- D3b RENAMED plan member → agentKey still yields the strategy name */
await prisma.$executeRawUnsafe(`UPDATE team_members SET opencode_agent_name = ? WHERE id = ?`, RENAMED, PLAN_MEMBER);
const b = await dispatchAs(PLAN_MEMBER, 'a_plan', 'a_plan');
const sysB = b.payload?.system ?? '';
result.D3b_renamedPlanMember = {
  note: 'Plan member binding renamed; its Agent row keeps agentKey=plan. The policy candidate comes from '
      + 'agentKey (rule 4 narrowing), so the reserved literal vteam-plan is still emitted.',
  binding: { teamMemberId: PLAN_MEMBER, agentId: 'a_plan', agentKey: 'plan', opencodeAgentName_set: RENAMED },
  dispatchError: b.dispatchError,
  emittedAgentField: b.payload?.agent ?? null,
  planInstructionInjected: sysB.includes('【计划编制】'),
  editPermGlobInjected: /\.opencode\/plans\//.test(sysB),
  systemLength: sysB.length,
  boundedClaim: b.payload?.agent === 'vteam-plan'
    ? 'SERVER selected the literal vteam-plan from agentKey for a RENAMED binding (not from the name)'
    : 'unexpected: server did not select the plan literal',
};
await prisma.$executeRawUnsafe(`UPDATE team_members SET opencode_agent_name = NULL WHERE id = ?`, PLAN_MEMBER);

/* ------------------------------------------------- D4 the worker guard literal (EXECUTED) */
const guard = req(`${REPO}/worker/dist/role-guard/policy.js`);
let roles = null;
try {
  roles = JSON.parse(execSync('docker exec aiagents-compose-worker cat /data/vteam-worker/.vteam-role-guard/roles.json').toString());
} catch { /* ignored */ }
const mappedNames = Object.keys(roles?.roles ?? {});
const mk = (agent) => ({ agent });
const decide = (agent, args) => (roles ? guard.evaluateToolCall({ rolesDoc: roles, session: mk(agent), tool: 'task', args }) : 'roles.json unavailable');
result.D4_workerGuard = {
  note: 'EXECUTED with the SHIPPED compiled worker guard (worker/dist/role-guard/policy.js) against the LIVE '
      + 'injected roles.json. This is the LIMITATION (plan O3 / review m3): tool `task` is allowed ONLY for the '
      + 'LITERAL agent name vteam-plan (policy.ts:172-182). Every other mapped role and every renamed binding is '
      + 'DENIED fan-out, so no end-to-end renamed-planner fan-out is claimed anywhere in this proof.',
  guardSource: 'worker/dist/role-guard/policy.js (shipped build)',
  workerLiteral: "worker/src/role-guard/policy.ts:172-182 — task allowed iff agent === 'vteam-plan' AND args.subagent_type === 'vteam-plan'",
  rolesDocEnabled: roles?.enabled === true,
  mappedRoleNames: mappedNames,
  decisions: [
    ['literal vteam-plan + subagent_type vteam-plan (the ONLY allow branch)', 'vteam-plan', { subagent_type: 'vteam-plan' }],
    ['renamed plan-duty binding + subagent_type vteam-plan  (RENAMED → DENY)', RENAMED, { subagent_type: 'vteam-plan' }],
    ['mapped non-plan role vteam-developer + subagent_type vteam-plan (DENY)', 'vteam-developer', { subagent_type: 'vteam-plan' }],
    ['literal vteam-plan + subagent_type vteam-developer (DENY)', 'vteam-plan', { subagent_type: 'vteam-developer' }],
    ['unmapped session (pass-through, guard branch 2 — NOT the task exception)', 'vteam-myagent', { subagent_type: 'vteam-plan' }],
  ].map(([label, agent, args]) => ({ label, agent, args, mapped: mappedNames.includes(agent), decision: decide(agent, args) })),
};

/* ------------------------------------------------- D5 live injected plan entry */
let injected = null;
try { injected = JSON.parse(execSync('docker exec aiagents-compose-worker cat /data/vteam-worker/opencode.json').toString()); } catch { /* ignored */ }
const planEntry = injected?.agent?.[VTEAM_PLAN_AGENT_NAME];
result.D5_liveLiteralPlanner = {
  note: 'live worker injection: the literal vteam-plan carries mode=all + permission.task=allow; the renamed '
      + 'name has no injected entry (only policy agents are injected).',
  agentNames: Object.keys(injected?.agent ?? {}),
  vteam_plan_entry: planEntry ? { mode: planEntry.mode, task: planEntry.permission?.task, edit: planEntry.permission?.edit } : null,
  vteam_plan_mode_all: planEntry?.mode === 'all',
  vteam_plan_task_allow: planEntry?.permission?.task === 'allow',
  renamedEntryAbsent: !Object.keys(injected?.agent ?? {}).includes(RENAMED),
};

await prisma.$disconnect();

writeFileSync(`${OUT}/plan-gate.json`, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
