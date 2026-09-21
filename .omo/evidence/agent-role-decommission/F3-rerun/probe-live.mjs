/**
 * F3 INDEPENDENT live probe (read-only against the LIVE DB):
 *  1) Execute the SHIPPED production assembler + policy resolver on live rows.
 *  2) Prove memory/artifact suppression differs between plan member and developer member.
 *  3) Execute the SHIPPED worker guard on literal vteam-plan vs a renamed planner.
 * No writes: Prisma query only + pure functions.
 */
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const REPO = '/Volumes/SSD-Data/01work/git-project/vteam';
const SERVER = `${REPO}/server`;
const OUT = '/var/folders/0y/1xtzqt_j3_g_1yff3gnkfsgc0000gn/T/opencode/f3live';
const req = createRequire(`${SERVER}/package.json`);
req('ts-node').register({
  transpileOnly: true, project: `${SERVER}/tsconfig.json`,
  compilerOptions: { module: 'commonjs', target: 'ES2021', experimentalDecorators: true,
    emitDecoratorMetadata: true, esModuleInterop: true, allowSyntheticDefaultImports: true, skipLibCheck: true },
});
req('reflect-metadata');
const { PrismaClient } = req('@prisma/client');
const DB_IP = execSync("docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' aiagents-compose-db").toString().trim();
const prisma = new PrismaClient({ datasources: { db: { url: `mysql://root:aiagents-root@${DB_IP}:3306/aiagents` } } });

const { buildSystemInstructions, roleLabelOfAgentKey } = req(`${SERVER}/src/chat/worker-dispatcher.ts`);
const { ExecutionPolicyService } = req(`${SERVER}/src/execution-policies/execution-policy.service.ts`);
const { getOpencodeAgentDuty } = req(`${SERVER}/src/common/opencode-agent-duty.ts`);
const { evaluateToolCall } = req(`${REPO}/worker/src/role-guard/policy.ts`);

const TEAM = 'tm_0000000001';
const policySvc = new ExecutionPolicyService(prisma, { nextId: async () => 'x' }, { broadcastCommand: async () => 0 });
const members = await prisma.teamMember.findMany({ where: { teamId: TEAM }, include: { agent: true, role: true } });
const out = { generatedAt: new Date().toISOString(), team: TEAM, members: [] };

for (const m of members) {
  const ag = m.agent;
  const resolved = await policySvc.resolveByAgent({ policyId: ag.policyId, agentKey: ag.agentKey });
  const resolvedTools = resolved && typeof resolved.tools === 'object' ? resolved.tools : null;
  const system = buildSystemInstructions(
    { id: ag.id, name: ag.name, role: roleLabelOfAgentKey(ag.agentKey), prompt: ag.prompt, persona: ag.persona, agentKey: ag.agentKey, policyId: ag.policyId },
    {
      isMainAgent: false, mainAgentInstanceId: 'tmm_0000000002',
      team: members.map((x) => ({ id: x.agent.id, name: x.agent.name, role: roleLabelOfAgentKey(x.agent.agentKey), instanceId: x.id, alias: x.alias, seq: x.seq })),
      selfInstanceId: m.id, selfAlias: m.alias, isWecomChannel: false, issueDetail: false,
      resolvedTools, rolePrompt: m.role?.rolePrompt ?? null, taskPlanMode: false,
    },
  );
  out.members.push({
    memberId: m.id, alias: m.alias, agentKey: ag.agentKey, roleKey: m.role?.key, policyId: ag.policyId,
    resolvedTools_memorySave: resolvedTools?.vteam_memory_save ?? null,
    resolvedTools_submitArtifact: resolvedTools?.vteam_submit_artifact ?? null,
    memorySectionPresent: system.includes('【长期记忆】') || system.includes('vteam_memory_save'),
    artifactSectionPresent: system.includes('【产出物提交】') || system.includes('vteam_submit_artifact'),
    identityLine: system.split('\n').find((l) => l.includes('【你的身份】')) ?? null,
    systemLength: system.length,
  });
}

/* worker-side guard: the shipped module decides `task` on the LITERAL vteam-plan */
const tools = { task: 'deny' }; // every vteam policy denies task; guard exception is the only allow
const basePolicy = { tools, bashDeny: [], correction: null };
out.workerGuard = {
  note: 'shipped evaluateToolCall(); vteam-plan literal vs renamed planner, same policy tools',
  literal_plan_task: evaluateToolCall({ agent: 'vteam-plan', tool: 'task', args: { subagent_type: 'vteam-plan' }, policy: basePolicy }),
  renamed_plan_task: evaluateToolCall({ agent: 'prometheus', tool: 'task', args: { subagent_type: 'vteam-plan' }, policy: basePolicy }),
  renamed_vteam_agent_task: evaluateToolCall({ agent: 'vteam-myplanner', tool: 'task', args: { subagent_type: 'vteam-plan' }, policy: basePolicy }),
  duty_vteam_plan: getOpencodeAgentDuty('vteam-plan'),
  duty_prometheus: getOpencodeAgentDuty('prometheus'),
  duty_vteam_myplanner: getOpencodeAgentDuty('vteam-myplanner'),
};
writeFileSync(`${OUT}/f3-live-probe.json`, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
await prisma.$disconnect();
