/** F3: exact section-marker presence/absence, live policy resolution, plan vs developer. */
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const REPO = '/Volumes/SSD-Data/01work/git-project/vteam';
const OUT = '/var/folders/0y/1xtzqt_j3_g_1yff3gnkfsgc0000gn/T/opencode/f3live';
const req = createRequire(`${REPO}/server/package.json`);
req('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'commonjs', target: 'ES2021', experimentalDecorators: true, emitDecoratorMetadata: true, esModuleInterop: true, skipLibCheck: true }, project: `${REPO}/server/tsconfig.json` });
req('reflect-metadata');
const { PrismaClient } = req('@prisma/client');
const DB_IP = execSync("docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' aiagents-compose-db").toString().trim();
const prisma = new PrismaClient({ datasources: { db: { url: `mysql://root:aiagents-root@${DB_IP}:3306/aiagents` } } });
const { buildSystemInstructions, roleLabelOfAgentKey, GLOBAL_SYSTEM_INSTRUCTIONS, GLOBAL_BASE_LINES } = req(`${REPO}/server/src/chat/worker-dispatcher.ts`);
const { ExecutionPolicyService } = req(`${REPO}/server/src/execution-policies/execution-policy.service.ts`);
const svc = new ExecutionPolicyService(prisma, { nextId: async () => 'x' }, { broadcastCommand: async () => 0 });
const memMarker = '【记忆管理】只存可复用经验';
const artMarker = '【公开与归档】';
const run = async (agentId, memberId) => {
  const ag = await prisma.agent.findUnique({ where: { id: agentId } });
  const m = await prisma.teamMember.findUnique({ where: { id: memberId }, include: { role: true } });
  const resolved = await svc.resolveByAgent({ policyId: ag.policyId, agentKey: ag.agentKey });
  const tools = resolved && typeof resolved.tools === 'object' ? resolved.tools : null;
  const sys = buildSystemInstructions(
    { id: ag.id, name: ag.name, role: roleLabelOfAgentKey(ag.agentKey), prompt: ag.prompt, persona: ag.persona, agentKey: ag.agentKey, policyId: ag.policyId },
    { isMainAgent: false, selfInstanceId: m.id, selfAlias: m.alias, resolvedTools: tools, rolePrompt: m.role?.rolePrompt ?? null, taskPlanMode: false },
  );
  return { agentId, memberId, alias: m.alias, agentKey: ag.agentKey, memorySave: tools?.vteam_memory_save ?? null, submitArtifact: tools?.vteam_submit_artifact ?? null,
    memorySection: sys.includes(memMarker), artifactSection: sys.includes(artMarker),
    globalHeaderTextStartsWithBase: sys.startsWith('你是 AI 协作平台的 Agent'),
    sysLen: sys.length };
};
const out = {
  generatedAt: new Date().toISOString(),
  globalFullContainsMemory: GLOBAL_SYSTEM_INSTRUCTIONS.includes(memMarker),
  plan: await run('a_plan', 'tmm_0000000006'),
  developer: await run('a_developer', 'tmm_0000000004'),
};
writeFileSync(`${OUT}/f3-suppression.json`, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
await prisma.$disconnect();
