/**
 * todo 9 (b) — BEFORE/AFTER behaviour matrix capture.
 *
 *   node capture.mjs before <dbName> <outFile>   # PRE source (@3659243) + pre-drop DB
 *   node capture.mjs after  <dbName> <outFile>   # HEAD source         + migrated DB
 *
 * Four values per seeded team member, resolved by the REAL production classes against
 * the REAL DB over TCP (no mocks):
 *   1. resolved policy            ExecutionPolicyService.resolveByAgent
 *   2. resolved opencode agent    resolvePolicyAgentCandidate (dispatch candidate)
 *   3. plan-mode decision         getOpencodeAgentDuty(bound opencode agent) + the
 *                                 dispatcher's effectivePlan expression
 *   4. alias label                TeamsService.defaultAlias (label derivation)
 * plus two consumers the plan migrates: instruction suppression (resolved tools) and
 * roleNeedsIssueDetail.
 */
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';

const SERVER = '/Volumes/SSD-Data/01work/git-project/vteam/server';
const PRE = '/tmp/vteam-pre/server';
const INJ = '/Volumes/SSD-Data/01work/git-project/vteam/.omo/evidence/agent-role-decommission/task-9/injected-cases.json';

const MODE = process.argv[2];
const DB_NAME = process.argv[3];
const OUT_FILE = process.argv[4];
if (!['before', 'after'].includes(MODE)) throw new Error('mode must be before|after');

const req = createRequire(`${SERVER}/package.json`);
req('ts-node').register({
  transpileOnly: true, project: `${SERVER}/tsconfig.json`,
  compilerOptions: {
    module: 'commonjs', target: 'ES2021', experimentalDecorators: true,
    emitDecoratorMetadata: true, esModuleInterop: true,
    allowSyntheticDefaultImports: true, skipLibCheck: true,
  },
});
req('reflect-metadata');
const { PrismaClient } = req('@prisma/client');

const DB_IP = execSync("docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' aiagents-compose-db").toString().trim();
const ROOT = process.env.T9_ROOT || (MODE === 'before' ? PRE : SERVER);
const prisma = new PrismaClient({ datasources: { db: { url: `mysql://root:aiagents-root@${DB_IP}:3306/${DB_NAME}` } } });

const { ExecutionPolicyService } = req(`${ROOT}/src/execution-policies/execution-policy.service.ts`);
const { getOpencodeAgentDuty } = req(`${ROOT}/src/common/opencode-agent-duty.ts`);
const { resolvePolicyAgentCandidate, roleNeedsIssueDetail } = req(`${ROOT}/src/chat/worker-dispatcher.ts`);
const { TeamsService } = req(`${ROOT}/src/teams/teams.service.ts`);

const svc = new ExecutionPolicyService(prisma, { nextId: async () => 'x' }, { broadcastCommand: async () => 0 });
const teamsSvc = new TeamsService({}, {}, {}, {}, {});

// pre-drop `role` values for rows synthesized by inject.sql (the AFTER DB no longer has the column)
const injected = JSON.parse(readFileSync(INJ, 'utf8'));
const roleOf = injected.roleOf ?? {};
const historicalRole = (a) =>
  MODE === 'before' ? (a.role ?? null)
    : (a.id in roleOf ? roleOf[a.id] : (a.type === 'template' ? a.agent_key : null));

const digest = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16);

async function resolvedOf(a) {
  const input = MODE === 'before'
    ? { policyId: a.policy_id ?? null, role: historicalRole(a), agentKey: a.agent_key ?? null }
    : { policyId: a.policy_id ?? null, agentKey: a.agent_key ?? null, ...(process.env.T9_INCLUDE_ROLE === '1' ? { role: historicalRole(a) } : {}) };
  const r = await svc.resolveByAgent(input);
  if (!r) return null;
  const allow = (t) => r.tools?.[t] === 'allow' || r.tools?.[t] === 'ask';
  return {
    policyId: r.policyId, policyName: r.policyName, agentName: r.agentName,
    memorySectionSuppressed: !allow('vteam_memory_save'),
    artifactSectionSuppressed: !allow('vteam_submit_artifact'),
    toolsDigest: digest(r.tools), permissionDigest: digest(r.permission),
    correctionDigest: digest(r.correction), bashDenyDigest: digest(r.bashDeny),
    serverGated: r.serverGated,
  };
}

async function main() {
  const col = process.env.T9_ROLE_COL === '0' ? '' : ', role';
  const agents = await prisma.$queryRawUnsafe(
    `SELECT id, name, type, agent_key${col}, policy_id FROM agents ORDER BY type, id`);
  const members = await prisma.$queryRawUnsafe(
    `SELECT tm.id, tm.team_id, tm.agent_id, tm.alias, tm.seq, tm.role_id,
            tm.opencode_agent_name, ar.\`key\` AS role_key, ar.name AS role_name
       FROM team_members tm LEFT JOIN agent_roles ar ON ar.id = tm.role_id
      ORDER BY tm.team_id, tm.agent_id, tm.seq, tm.id`);
  const teams = await prisma.$queryRawUnsafe(`SELECT id, main_agent_member_id FROM teams ORDER BY id`);

  const byId = new Map(agents.map((a) => [a.id, a]));

  const agentRows = [];
  for (const a of agents) {
    agentRows.push({
      agentId: a.id, name: a.name, type: a.type, agentKey: a.agent_key ?? null,
      historicalRole: historicalRole(a), policyIdColumn: a.policy_id ?? null,
      policy: await resolvedOf(a),
      policyCandidate: resolvePolicyAgentCandidate({ agentKey: a.agent_key, role: historicalRole(a) }),
      planDuty: getOpencodeAgentDuty(a.agent_key ? `vteam-${a.agent_key}` : null),
      issueDetail: MODE === 'before'
        ? roleNeedsIssueDetail(historicalRole(a))
        : roleNeedsIssueDetail(a.agent_key ?? null),
    });
  }

  const memberRows = [];
  for (const tm of members) {
    const a = byId.get(tm.agent_id);
    const derivedAlias = MODE === 'before'
      ? teamsSvc.defaultAlias({ name: a?.name ?? tm.agent_id, role: historicalRole(a) }, Number(tm.seq))
      : teamsSvc.defaultAlias(
          { name: a?.name ?? tm.agent_id }, Number(tm.seq),
          tm.role_id ? { key: tm.role_key ?? '', name: tm.role_name ?? '' } : null);
    memberRows.push({
      teamId: tm.team_id, memberId: tm.id, agentId: tm.agent_id, seq: Number(tm.seq),
      agentKey: a?.agent_key ?? null, historicalRole: historicalRole(a),
      roleId: tm.role_id ?? null, roleKey: tm.role_key ?? null, roleName: tm.role_name ?? null,
      storedAlias: tm.alias ?? null, opencodeAgentName: tm.opencode_agent_name ?? null,
      policy: await resolvedOf(a),
      policyCandidate: resolvePolicyAgentCandidate({ agentKey: a?.agent_key, role: historicalRole(a) }),
      planDuty: getOpencodeAgentDuty(a?.agent_key ? `vteam-${a.agent_key}` : null),
      issueDetail: MODE === 'before'
        ? roleNeedsIssueDetail(historicalRole(a))
        : roleNeedsIssueDetail(a?.agent_key ?? null),
      derivedAlias,
      aliasMatchesStored: derivedAlias === (tm.alias ?? null),
    });
  }

  const teamRows = teams.map((t) => {
    const main = members.find((m) => m.id === t.main_agent_member_id) ?? null;
    const a = main ? byId.get(main.agent_id) : null;
    // dispatcher expression, identical in both code versions (verified by source diff):
    //   effectivePlan = explicit(task.planMode) || getOpencodeAgentDuty(mainMember.opencodeAgentName)==='plan'
    // the first disjunct is task data (unchanged by this plan); we record the duty disjunct,
    // which is the part the plan rewrites.
    return {
      teamId: t.id, mainMemberId: t.main_agent_member_id ?? null,
      mainAgentId: main?.agent_id ?? null, mainAgentKey: a?.agent_key ?? null,
      mainOpencodeAgentName: main?.opencode_agent_name ?? null,
      mainPlanDuty: getOpencodeAgentDuty(main?.opencode_agent_name ?? null),
      effectivePlanDutyDisjunct: getOpencodeAgentDuty(main?.opencode_agent_name ?? null) === 'plan',
    };
  });

  const out = {
    mode: MODE, dbName: DB_NAME, sourceRoot: ROOT, capturedAt: new Date().toISOString(),
    counts: { agents: agents.length, members: members.length, teams: teams.length },
    agents: agentRows, members: memberRows, teams: teamRows,
  };
  writeFileSync(OUT_FILE, JSON.stringify(JSON.parse(JSON.stringify(out)), null, 2) + '\n');
  console.log(`[${MODE}] ${OUT_FILE}: agents=${agents.length} members=${members.length} teams=${teams.length}`);
  await prisma.$disconnect();
}

await main();
