/**
 * todo 9 (step 4b/4c) — assembled instructions for a seeded member on the FRESH stack:
 * prove the identity line renders the key-derived label exactly once, the roster line
 * renders each member once, and the plan-duty suppression is tool-derived.
 *
 * Runs against the SCRATCH COPY (aiagents_t9pg, dropped at cleanup). Renames are confined
 * to the scratch DB.
 */
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
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

const { buildSystemInstructions, roleLabelOfAgentKey } = req(`${SERVER}/src/chat/worker-dispatcher.ts`);
const { ExecutionPolicyService } = req(`${SERVER}/src/execution-policies/execution-policy.service.ts`);

const TEAM = 'tm_0000000001';
const TASK = 't_0000000001';
const policySvc = new ExecutionPolicyService(prisma, { nextId: async () => 'x' }, { broadcastCommand: async () => 0 });

// Resolve the policy for a given agent row exactly like the dispatcher does, then assemble.
const agentRow = await prisma.agent.findUnique({ where: { id: 'a_plan' } });
const memberRow = await prisma.teamMember.findUnique({ where: { id: 'tmm_0000000006' }, include: { role: true } });
const members = await prisma.teamMember.findMany({ where: { teamId: TEAM }, include: { agent: { select: { id: true, name: true, agentKey: true } } } });

// resolveBoundaryAndTools equivalent: the resolved execution policy tools for the bound agent.
const resolved = await policySvc.resolveByAgent({ policyId: agentRow.policyId, agentKey: agentRow.agentKey });
const resolvedTools = resolved && typeof resolved.tools === 'object' ? resolved.tools : null;

const system = buildSystemInstructions(
  { id: agentRow.id, name: agentRow.name, role: roleLabelOfAgentKey(agentRow.agentKey), prompt: agentRow.prompt, persona: agentRow.persona, agentKey: agentRow.agentKey, policyId: agentRow.policyId },
  {
    isMainAgent: false,
    mainAgentInstanceId: 'tmm_0000000002',
    team: members.map((m) => ({ id: m.agent.id, name: m.agent.name, role: roleLabelOfAgentKey(m.agent.agentKey), instanceId: m.id, alias: m.alias, seq: m.seq })),
    selfInstanceId: 'tmm_0000000006',
    selfAlias: memberRow.alias,
    persistentWorkDir: `/data/vteam-worker/tasks/${TASK}`,
    isWecomChannel: false,
    issueDetail: false,
    resolvedTools,
    rolePrompt: memberRow.role?.rolePrompt ?? null,
    taskPlanMode: false,
  },
);

const identityLine = system.split('\n').find((l) => l.includes('【你的身份】')) ?? '';
const rosterLines = system.split('\n').filter((l) => /^- .*实例 id: tmm_/.test(l));
const countOccurrences = (s, sub) => s.split(sub).length - 1;

const out = {
  generatedAt: new Date().toISOString(),
  scratchDb: DB_NAME,
  member: {
    teamMemberId: 'tmm_0000000006', alias: memberRow.alias, agentId: agentRow.id,
    agentKey: agentRow.agentKey, roleId: memberRow.roleId, roleKey: memberRow.role?.key ?? null,
    roleLabel: roleLabelOfAgentKey(agentRow.agentKey),
  },
  resolvedTools,
  resolvedCorrectionScope: resolved?.correction?.scopeSummary ?? null,
  assertions: {
    identityLine,
    identityRoleValue: /角色: ([^\)）。]*)/.exec(identityLine)?.[1] ?? null,
    identityRoleOccurrences: countOccurrences(system, '角色: '),
    rosterLineCount: rosterLines.length,
    rosterLines,
    memorySectionPresent: system.includes('【团队记忆') || system.includes('memory_'),
    artifactSectionPresent: system.includes('submit_artifact') && system.includes('产出物'),
    charterPresent: system.includes('团队协作'), // 平台级共享块（无条件注入）
    planInstructionPresent: system.includes('【计划编制】'),
    systemLength: system.length,
  },
};

/* --------- contrast: a role whose policy HOLDS memory/artifact tools is NOT suppressed -------- */
const devRow = await prisma.agent.findUnique({ where: { id: 'a_developer' } });
const devMember = await prisma.teamMember.findUnique({ where: { id: 'tmm_0000000004' }, include: { role: true } });
const devResolved = await policySvc.resolveByAgent({ policyId: devRow.policyId, agentKey: devRow.agentKey });
const devTools = devResolved && typeof devResolved.tools === 'object' ? devResolved.tools : null;
const devSystem = buildSystemInstructions(
  { id: devRow.id, name: devRow.name, role: roleLabelOfAgentKey(devRow.agentKey), prompt: devRow.prompt, persona: devRow.persona, agentKey: devRow.agentKey, policyId: devRow.policyId },
  { isMainAgent: false, mainAgentInstanceId: 'tmm_0000000002', team: [], selfInstanceId: 'tmm_0000000004',
    selfAlias: devMember.alias, persistentWorkDir: `/data/vteam-worker/tasks/${TASK}`, isWecomChannel: false,
    issueDetail: true, resolvedTools: devTools, rolePrompt: devMember.role?.rolePrompt ?? null, taskPlanMode: false },
);
out.contrast_developer = {
  note: 'same assembler, different agent: the developer policy HOLDS vteam_memory_save / vteam_submit_artifact, '
      + 'so the suppression predicate (resolvedTools lacks the tool) is false and both sections render.',
  member: { teamMemberId: 'tmm_0000000004', alias: devMember.alias, agentId: devRow.id, agentKey: devRow.agentKey },
  holdsMemorySave: Boolean(devTools && Object.prototype.hasOwnProperty.call(devTools, 'vteam_memory_save')),
  holdsSubmitArtifact: Boolean(devTools && Object.prototype.hasOwnProperty.call(devTools, 'vteam_submit_artifact')),
  memorySectionPresent: devSystem.includes('memory') || devSystem.includes('【团队记忆'),
  artifactSectionPresent: devSystem.includes('submit_artifact'),
  issueDetailPresent: devSystem.includes('issue'),
  systemLength: devSystem.length,
};

writeFileSync(`${OUT}/assembled-instructions.json`, JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out, null, 2));
await prisma.$disconnect();
