/** F3 independent worker-guard probe using the LIVE /agent-policies guard.roles doc. */
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const REPO = '/Volumes/SSD-Data/01work/git-project/vteam';
const OUT = '/var/folders/0y/1xtzqt_j3_g_1yff3gnkfsgc0000gn/T/opencode/f3live';
const req = createRequire(`${REPO}/server/package.json`);
req('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'commonjs', target: 'ES2021', skipLibCheck: true }, project: `${REPO}/server/tsconfig.json` });
const { evaluateToolCall } = req(`${REPO}/worker/src/role-guard/policy.ts`);
const TOKEN = execSync(`cat /var/folders/0y/1xtzqt_j3_g_1yff3gnkfsgc0000gn/T/opencode/f3-token.txt`).toString().trim();
const res = await fetch('http://localhost:13000/api/v1/agent-policies', { headers: { Authorization: `Bearer ${TOKEN}` } });
const live = await res.json();
const rolesDoc = { enabled: true, roles: live.guard.roles };
const cases = [
  ['literal vteam-plan + subagent_type=vteam-plan', 'vteam-plan', { subagent_type: 'vteam-plan' }],
  ['renamed prometheus + subagent_type=vteam-plan', 'prometheus', { subagent_type: 'vteam-plan' }],
  ['renamed vteam-myplanner + subagent_type=vteam-plan', 'vteam-myplanner', { subagent_type: 'vteam-plan' }],
  ['literal vteam-plan + other subagent', 'vteam-plan', { subagent_type: 'build' }],
  ['vteam-plan bash rm -rf', 'vteam-plan', { command: 'rm -rf /tmp/x' }],
];
const out = { generatedAt: new Date().toISOString(), liveRoles: Object.keys(live.guard.roles), results: [] };
for (const [label, agent, args] of cases) {
  const tool = label.includes('bash') ? 'bash' : 'task';
  out.results.push({ label, agent, tool, decision: evaluateToolCall({ rolesDoc, session: { agent }, tool, args }) });
}
writeFileSync(`${OUT}/f3-guard.json`, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
