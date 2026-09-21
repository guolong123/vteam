/** F3: server-side selection from DATA — live rows, production functions. */
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
const REPO = '/Volumes/SSD-Data/01work/git-project/vteam';
const req = createRequire(`${REPO}/server/package.json`);
req('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'commonjs', target: 'ES2021', experimentalDecorators: true, emitDecoratorMetadata: true, esModuleInterop: true, skipLibCheck: true }, project: `${REPO}/server/tsconfig.json` });
req('reflect-metadata');
const { PrismaClient } = req('@prisma/client');
const DB_IP = execSync("docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' aiagents-compose-db").toString().trim();
const prisma = new PrismaClient({ datasources: { db: { url: `mysql://root:aiagents-root@${DB_IP}:3306/aiagents` } } });
const { resolvePolicyAgentCandidate, roleLabelOfAgentKey } = req(`${REPO}/server/src/chat/worker-dispatcher.ts`);
const { getOpencodeAgentDuty, VTEAM_PLAN_AGENT_NAME } = req(`${REPO}/server/src/common/opencode-agent-duty.ts`);
const agents = await prisma.agent.findMany();
console.log('VTEAM_PLAN_AGENT_NAME =', VTEAM_PLAN_AGENT_NAME);
for (const a of agents) {
  console.log(`${a.id} agentKey=${a.agentKey} -> candidate=${resolvePolicyAgentCandidate({ agentKey: a.agentKey })} label=${JSON.stringify(roleLabelOfAgentKey(a.agentKey))}`);
}
console.log('duty vteam-plan =', getOpencodeAgentDuty('vteam-plan'), '| duty "Prometheus - Plan Builder" =', getOpencodeAgentDuty('Prometheus - Plan Builder'), '| duty build =', getOpencodeAgentDuty('build'));
console.log('candidate({agentKey:null}) =', resolvePolicyAgentCandidate({ agentKey: null }), '| candidate({agentKey:"myagent"}) =', resolvePolicyAgentCandidate({ agentKey: 'myagent' }));
await prisma.$disconnect();
