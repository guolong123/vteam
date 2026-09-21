/** F3: does the shipped guard deny `task` for a MAPPED renamed planner? */
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
const REPO = '/Volumes/SSD-Data/01work/git-project/vteam';
const req = createRequire(`${REPO}/server/package.json`);
req('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'commonjs', target: 'ES2021', skipLibCheck: true }, project: `${REPO}/server/tsconfig.json` });
const { evaluateToolCall } = req(`${REPO}/worker/src/role-guard/policy.ts`);
const TOKEN = execSync(`cat /var/folders/0y/1xtzqt_j3_g_1yff3gnkfsgc0000gn/T/opencode/f3-token.txt`).toString().trim();
const live = await (await fetch('http://localhost:13000/api/v1/agent-policies', { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
const planRole = live.guard.roles['vteam-plan'];
const rolesDoc = { enabled: true, roles: { ...live.guard.roles, 'vteam-myplanner': planRole, 'prometheus-renamed': planRole } };
console.log(JSON.stringify({
  mapped_renamed_subagent_plan: evaluateToolCall({ rolesDoc, session: { agent: 'vteam-myplanner' }, tool: 'task', args: { subagent_type: 'vteam-plan' } }),
  mapped_prometheus_subagent_plan: evaluateToolCall({ rolesDoc, session: { agent: 'prometheus-renamed' }, tool: 'task', args: { subagent_type: 'vteam-plan' } }),
  literal_plan_subagent_plan: evaluateToolCall({ rolesDoc, session: { agent: 'vteam-plan' }, tool: 'task', args: { subagent_type: 'vteam-plan' } }),
  literal_plan_wrong_subagent: evaluateToolCall({ rolesDoc, session: { agent: 'vteam-plan' }, tool: 'task', args: { subagent_type: 'build' } }),
  unmapped_passthrough: evaluateToolCall({ rolesDoc, session: { agent: 'never-mapped' }, tool: 'task', args: { subagent_type: 'vteam-plan' } }),
}, null, 2));
